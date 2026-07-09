/**
 * get-subagent-result-renderer.test.ts — proves background result retrieval keeps
 * the full tool result for the model while Pi renders it compactly unless the
 * existing expansion control is open.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const textOf = (result: any): string => result.content[0].text;
const renderText = (component: any): string => component.render(120).map((line: string) => line.trimEnd()).join("\n");

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

async function spawnCompletedBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-LONG-SUBAGENT-RESULT\nsecond line that should stay hidden while collapsed",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Summarize generated output", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}

describe("get_subagent_result renderer", () => {
  let tmpDir: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-result-renderer-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-result-renderer-agentdir-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    previousCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("collapses the main chat rendering while preserving the full tool result for expansion", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    const result = await tools.get("get_subagent_result").execute(
      "tc-read",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain("THE-LONG-SUBAGENT-RESULT");

    const tool = tools.get("get_subagent_result");
    const collapsed = renderText(tool.renderResult(result, { expanded: false }, theme));
    expect(collapsed).toContain("Done");
    expect(collapsed).toContain("Summarize generated output");
    expect(collapsed).not.toContain("THE-LONG-SUBAGENT-RESULT");

    const expanded = renderText(tool.renderResult(result, { expanded: true }, theme));
    expect(expanded).toContain("THE-LONG-SUBAGENT-RESULT");
    expect(expanded).toContain("second line that should stay hidden while collapsed");
  });

  it("reports an empty aborted final assistant turn as aborted with a diagnostic, not completed with no output", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      for (let i = 1; i <= 25; i++) {
        opts.onTurnEnd?.(i);
        opts.onToolActivity?.({ type: "start", toolName: "read" });
        opts.onToolActivity?.({ type: "end", toolName: "read" });
      }
      opts.onAssistantUsage?.({ input: 500_000, output: 10_000, cacheWrite: 1_400 });
      return {
        responseText: "",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
        terminalStopReason: "aborted",
        terminalErrorMessage: "Request was aborted",
        finalAssistantText: "",
      };
    });

    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const spawn = await tools.get("Agent").execute(
      "tc-spawn-aborted",
      { prompt: "go", description: "Investigate no output", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();
    await flush();

    const result = await tools.get("get_subagent_result").execute(
      "tc-read-aborted",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );

    const output = textOf(result);
    expect(output).toContain("Status: aborted");
    expect(output).toContain("Final assistant turn ended with stopReason \"aborted\": Request was aborted");
    expect(output).toContain("Tool uses: 25");
    expect(output).not.toContain("Status: completed");
    expect(output).not.toContain("No output.");

    const collapsed = renderText(tools.get("get_subagent_result").renderResult(result, { expanded: false }, theme));
    expect(collapsed).toContain("Aborted:");
    expect(collapsed).toContain("Request was aborted");
    expect(collapsed).toContain("Investigate no output");
  });
});
