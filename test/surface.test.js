import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { adapterFor, detectSurface, isDesktopSurface } from "../lib/surface.js";
import {
  findDesktopAppExecutable,
  isInsideDesktopInstall,
  isSealedRuntimeDir,
  resolveDesktopAiBase,
  restartPlan,
  scheduleRestart,
} from "../lib/desktop.js";
import { restartArgv } from "../lib/web.js";
import * as core from "../lib/core.js";

const prevSurface = process.env.DSH_SURFACE;
const prevBase = process.env.DSH_BASE;

afterEach(() => {
  if (prevSurface === undefined) delete process.env.DSH_SURFACE;
  else process.env.DSH_SURFACE = prevSurface;
  if (prevBase === undefined) delete process.env.DSH_BASE;
  else process.env.DSH_BASE = prevBase;
  core.resetPathMemo();
});

describe("surface detect", () => {
  it("defaults to web for a normal node process", () => {
    assert.equal(detectSurface({
      env: { DSH_DESKTOP_DEFAULT_PROFILE: "desktop" },
      execPath: path.join(os.tmpdir(), "node.exe"),
      argv: ["node", "bin.js", "web"],
      resourcesPath: "",
    }), "web");
    assert.equal(adapterFor("web"), "web");
  });

  it("detects community Desktop from exe / env / desktop-cli", () => {
    assert.equal(detectSurface({
      env: {},
      execPath: path.join("D:", "DSH Desktop", "DSH Desktop.exe"),
      argv: ["DSH Desktop.exe"],
      resourcesPath: "",
    }), "desktop");
    assert.equal(isDesktopSurface({
      env: { DSH_DESKTOP_DEFAULT_PROFILE: "desktop" },
      execPath: "node.exe",
      argv: ["node", "bin.js", "web"],
    }), false);
    assert.equal(detectSurface({
      env: {},
      execPath: "node.exe",
      argv: ["node", "E:/app/lib/desktop-cli.js", "plugin"],
    }), "desktop");
    assert.equal(detectSurface({
      env: {},
      execPath: "C:/Program Files/nodejs/node.exe",
      argv: ["C:/Program Files/nodejs/node.exe", "D:/DSH Desktop/resources/app/lib/host-process-entry.js"],
      resourcesPath: "D:/DSH Desktop/resources",
    }), "desktop");
    assert.equal(adapterFor("desktop"), "desktop");
  });

  it("honors DSH_SURFACE for gui/tui and falls back adapter to web", () => {
    assert.equal(detectSurface({ env: { DSH_SURFACE: "gui" } }), "gui");
    assert.equal(detectSurface({ env: { DSH_SURFACE: "tui" } }), "tui");
    assert.equal(adapterFor("gui"), "web");
    assert.equal(adapterFor("tui"), "web");
  });
});

describe("desktop package root", () => {
  it("resolves @deepseek-ai under resources/app, not asar-only", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-desk-"));
    const install = path.join(root, "DSH Desktop");
    const ai = path.join(install, "resources", "app", "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
    const exe = path.join(install, "DSH Desktop.exe");
    fs.writeFileSync(exe, "");
    const hit = resolveDesktopAiBase({
      execPath: exe,
      resourcesPath: path.join(install, "resources"),
      argv: [exe],
    });
    assert.equal(path.normalize(hit), path.normalize(ai));
    assert.equal(findDesktopAppExecutable({ execPath: exe }), path.normalize(exe));
  });

  it("web findAiBase ignores a desktop DSH_BASE", () => {
    process.env.DSH_SURFACE = "web";
    process.env.DSH_BASE = "D:/DSH Desktop/resources/app/node_modules/@deepseek-ai";
    core.resetPathMemo();
    const base = core.findAiBase();
    if (base) {
      assert.ok(!/dsh desktop/i.test(base), `web findAiBase leaked desktop: ${base}`);
    }
  });

  it("desktop findAiBase does not leak onto npm-global", () => {
    process.env.DSH_SURFACE = "desktop";
    delete process.env.DSH_BASE;
    core.resetPathMemo();
    const base = core.findAiBase();
    if (base) {
      assert.ok(isInsideDesktopInstall(base), `desktop findAiBase leaked: ${base}`);
      assert.ok(!/npm-global/i.test(base), `desktop findAiBase leaked npm-global: ${base}`);
    }
  });

  it("resolves @deepseek-ai from a custom install dir without DSH Desktop in the folder name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-custom-"));
    const install = path.join(root, "MyApps", "Harness");
    const ai = path.join(install, "resources", "app", "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
    const exe = path.join(install, "DSH Desktop.exe");
    fs.writeFileSync(exe, "");
    const hit = resolveDesktopAiBase({
      execPath: exe,
      resourcesPath: path.join(install, "resources"),
      argv: [exe, path.join(install, "resources", "app", "lib", "host-process-entry.js")],
    });
    assert.equal(path.normalize(hit), path.normalize(ai));
    assert.equal(isInsideDesktopInstall(path.join(ai, "dsh-base", "x.js"), {
      execPath: exe,
      resourcesPath: path.join(install, "resources"),
    }), true);
    assert.equal(isInsideDesktopInstall("D:/DeepSeek Harness/npm-global/node_modules/@deepseek-ai/x.js", {
      execPath: exe,
      resourcesPath: path.join(install, "resources"),
    }), false);
  });

  it("findAiBase + allowTargetPath follow a custom Desktop tree via DSH_BASE", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-base-"));
    const install = path.join(root, "Tools", "App");
    const ai = path.join(install, "resources", "app", "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
    fs.writeFileSync(path.join(install, "DSH Desktop.exe"), "");
    const target = path.join(ai, "dsh-base", "x.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");

    process.env.DSH_SURFACE = "desktop";
    process.env.DSH_BASE = ai;
    core.resetPathMemo();
    assert.equal(path.normalize(core.findAiBase()), path.normalize(ai));
    assert.equal(core.allowTargetPath(target), true);
    assert.equal(core.pathZone(target), "desktop-install");

    process.env.DSH_SURFACE = "web";
    core.resetPathMemo();
    assert.equal(core.allowTargetPath(target), false);
    assert.equal(core.pathZone(target), "desktop-install");
  });
});

describe("restart plans", () => {
  it("web restartArgv injects web --port when neither web nor desktop is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-web-miss-"));
    const binJs = path.join(tmp, "lib", "bin.js");
    fs.mkdirSync(path.dirname(binJs), { recursive: true });
    fs.writeFileSync(binJs, "");
    const argv = restartArgv({
      argv: ["node", "ignored", "--profile", "default"],
      findBinRoot: () => tmp,
    });
    assert.deepEqual(argv.slice(0, 4), [binJs, "web", "--port", String(Number(process.env.PORT) || 3080)]);
    assert.ok(argv.includes("--no-open"));
  });

  it("web restartArgv keeps an existing web subcommand", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-web-"));
    const binJs = path.join(tmp, "lib", "bin.js");
    fs.mkdirSync(path.dirname(binJs), { recursive: true });
    fs.writeFileSync(binJs, "");
    const argv = restartArgv({
      argv: ["node", "ignored", "web", "--port", "3080"],
      findBinRoot: () => tmp,
    });
    assert.equal(argv[0], binJs);
    assert.deepEqual(argv.slice(1), ["web", "--port", "3080", "--no-open"]);
  });

  it("desktop scheduleRestart only calls app relaunch, not Host exit", async () => {
    let calls = 0;
    scheduleRestart({}, {
      get(name) {
        if (name !== "desktopRuntime" && name !== "desktopActions") return null;
        return { requestRestart: () => { calls += 1; return Promise.resolve(); } };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
  });

  it("desktop restartPlan launches the exe with empty argv", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-rst-"));
    const exe = path.join(root, "DSH Desktop.exe");
    fs.writeFileSync(exe, "");
    const plan = restartPlan({ execPath: exe, argv: [exe], resourcesPath: "" });
    assert.equal(plan.kind, "desktop");
    assert.equal(plan.execPath, path.normalize(exe));
    assert.deepEqual(plan.argv, []);
    assert.equal(plan.cwd, path.dirname(path.normalize(exe)));
  });
});

describe("sealed runtime dirs", () => {
  it("treats host-commands generations and runtime-commands as sealed", () => {
    assert.equal(
      isSealedRuntimeDir("C:/Users/me/AppData/Roaming/DSH Desktop/host-commands/desktop/generations/abc/bin"),
      true,
    );
    assert.equal(
      isSealedRuntimeDir("C:/Users/me/AppData/Roaming/DSH Desktop/runtime-commands/desktop/generations/abc/bin"),
      true,
    );
    assert.equal(isSealedRuntimeDir("D:/DeepSeek Harness/npm-global"), false);
  });
});

describe("surface path isolation", () => {
  it("desktop allow list excludes web install and web profile", () => {
    process.env.DSH_SURFACE = "desktop";
    assert.equal(core.allowTargetPath("D:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-base/x.js"), true);
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/npm-global/node_modules/@deepseek-ai/x.js"), false);
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/.dsh/profiles/web/cordis.patch.yml"), false);
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/.dsh/.agent-presets/liangshen/agent.cordis.yml"), false);
  });

  it("web allow list excludes desktop install and desktop profile", () => {
    process.env.DSH_SURFACE = "web";
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/npm-global/node_modules/@deepseek-ai/x.js"), true);
    assert.equal(core.allowTargetPath("D:/DSH Desktop/resources/app/node_modules/@earendil-works/pi-ai/x.js"), false);
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/.dsh/profiles/desktop/package.json"), false);
    assert.equal(core.allowTargetPath("D:/DeepSeek Harness/.dsh/.agent-presets/liangshen/agent.cordis.yml"), true);
  });
});
