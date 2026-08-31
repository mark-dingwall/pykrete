import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globalConfigPath,
  globalCredentialsPath,
  resolveConfigPath,
  xdgConfigHome,
} from "./paths.ts";
import { ConfigError } from "./config.ts";

test("xdgConfigHome uses an absolute XDG_CONFIG_HOME", () => {
  assert.equal(
    xdgConfigHome({ env: { XDG_CONFIG_HOME: "/custom/config" }, homeDir: "/home/tester" }),
    "/custom/config",
  );
});

test("xdgConfigHome falls back for unset, empty, or relative XDG_CONFIG_HOME", () => {
  for (const value of [undefined, "", "relative/config"]) {
    assert.equal(
      xdgConfigHome({ env: { XDG_CONFIG_HOME: value }, homeDir: "/home/tester" }),
      "/home/tester/.config",
    );
  }
});

test("xdgConfigHome rejects an empty or relative fallback home", () => {
  for (const homeDir of ["", "relative/home"]) {
    assert.throws(
      () => xdgConfigHome({ env: {}, homeDir }),
      (err) => err instanceof ConfigError && /absolute home directory/.test(err.message),
    );
  }
});

test("global Pykrete paths share the resolved XDG directory", () => {
  const options = { env: { XDG_CONFIG_HOME: "/custom/config" }, homeDir: "/ignored" };
  assert.equal(globalConfigPath(options), "/custom/config/pykrete/pykrete.toml");
  assert.equal(globalCredentialsPath(options), "/custom/config/pykrete/credentials.env");
});

test("resolveConfigPath gives an explicit CLI path highest precedence even when missing", () => {
  assert.equal(
    resolveConfigPath("missing-explicit.toml", {
      env: { PYKRETE_CONFIG: "from-env.toml", XDG_CONFIG_HOME: "/global" },
      cwd: "/project",
      homeDir: "/home/tester",
      statSync: () => undefined,
    }),
    "missing-explicit.toml",
  );
});

test("resolveConfigPath uses a non-empty PYKRETE_CONFIG before cwd", () => {
  assert.equal(
    resolveConfigPath(undefined, {
      env: { PYKRETE_CONFIG: "from-env.toml", XDG_CONFIG_HOME: "/global" },
      cwd: "/project",
      homeDir: "/home/tester",
      statSync: () => undefined,
    }),
    "from-env.toml",
  );
});

test("resolveConfigPath uses cwd pykrete.toml when no explicit source is set", () => {
  assert.equal(
    resolveConfigPath(undefined, {
      env: { XDG_CONFIG_HOME: "/global" },
      cwd: "/project",
      homeDir: "/home/tester",
      statSync: (path) => {
        if (path !== "/project/pykrete.toml") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    "/project/pykrete.toml",
  );
});

test("resolveConfigPath falls back to the global path when cwd has no config", () => {
  assert.equal(
    resolveConfigPath(undefined, {
      env: { PYKRETE_CONFIG: "", XDG_CONFIG_HOME: "/global" },
      cwd: "/project",
      homeDir: "/home/tester",
      statSync: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    "/global/pykrete/pykrete.toml",
  );
});

test("resolveConfigPath normalizes cwd lookup failures", () => {
  assert.throws(
    () => resolveConfigPath(undefined, {
      env: { XDG_CONFIG_HOME: "/global" },
      cwdFn: () => {
        throw Object.assign(new Error("working directory was removed"), { code: "ENOENT" });
      },
    }),
    (err) => err instanceof ConfigError && /cannot resolve working directory/.test(err.message),
  );
});

test("resolveConfigPath fails closed when the local config cannot be inspected", () => {
  assert.throws(
    () => resolveConfigPath(undefined, {
      env: { XDG_CONFIG_HOME: "/global" },
      cwd: "/project",
      statSync: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    }),
    (err) => err instanceof ConfigError && /cannot inspect local config/.test(err.message),
  );
});
