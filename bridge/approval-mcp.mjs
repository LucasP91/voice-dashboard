#!/usr/bin/env node
// Approval hook for the Claude bridge: a tiny MCP server (stdio) that Claude Code calls, through
// --permission-prompt-tool, whenever it wants to use a tool that needs permission (sending an email, adding an event,
// editing a file…). It asks the bridge, which shows the request on the dashboard and waits for Allow / Don't allow.
//
// Started by Claude Code, not by you. Environment: BRIDGE_URL, BRIDGE_INTERNAL (a per-run secret), BRIDGE_JOB.
import readline from 'node:readline';

const { BRIDGE_URL, BRIDGE_INTERNAL, BRIDGE_JOB, BRIDGE_TEST_DECISION } = process.env;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const deny = (message) => ({ behavior: 'deny', message });

async function decide(args) {
  const tool = String(args?.tool_name || '');
  const input = args?.input && typeof args.input === 'object' ? args.input : {};
  if (BRIDGE_TEST_DECISION === 'deny') return deny('Denied (test).');
  try {
    const res = await fetch(`${BRIDGE_URL}/internal/approval`, {
      method: 'POST',
      body: JSON.stringify({ secret: BRIDGE_INTERNAL, job: BRIDGE_JOB, tool, input }),
    });
    const data = await res.json();
    if (data.allow) return { behavior: 'allow', updatedInput: input };
    return deny(data.message || 'The user said no on the dashboard. Don’t try again; tell them it wasn’t done.');
  } catch {
    return deny('Couldn’t ask the user for permission, so this wasn’t done.');
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dashboard', version: '1.0.0' } } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'approve',
      description: 'Permission prompts for the dashboard (used by Claude Code itself, not for answering questions).',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    }] } });
  }
  if (method === 'tools/call') {
    const decision = await decide(params?.arguments);
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
