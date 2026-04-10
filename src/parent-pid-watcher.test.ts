import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RED phase — will be GREEN after T18.
// @ts-expect-error T18 creates this module and makes these tests executable.
import { ParentPidWatcher, watchParentAndExit } from "./parent-pid-watcher.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalPpidDescriptor = Object.getOwnPropertyDescriptor(process, "ppid");

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restoreParentPid(): void {
  if (originalPpidDescriptor) {
    Object.defineProperty(process, "ppid", originalPpidDescriptor);
  }
}

function setCurrentParentPid(ppid: number): void {
  Object.defineProperty(process, "ppid", {
    value: ppid,
    configurable: true,
  });
}

function makeProcessError(code: "EPERM" | "ESRCH"): NodeJS.ErrnoException {
  const error = new Error(`process.kill failed with ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("ParentPidWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    restorePlatform();
    restoreParentPid();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restorePlatform();
    restoreParentPid();
  });

  it("starts polling parent PID every 5 seconds by default", () => {
    const onParentGone = vi.fn();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 5000);

    vi.advanceTimersByTime(5000);

    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it("fires the callback when process.kill(parentPid, 0) reports ESRCH", () => {
    const onParentGone = vi.fn();

    vi.spyOn(process, "kill").mockImplementation(() => {
      throw makeProcessError("ESRCH");
    });

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();
    vi.advanceTimersByTime(5000);

    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it("fires the callback when process.ppid changes away from the configured parent PID", () => {
    const onParentGone = vi.fn();
    setCurrentParentPid(4242);

    vi.spyOn(process, "kill").mockImplementation(() => true);

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();
    setCurrentParentPid(9001);
    vi.advanceTimersByTime(5000);

    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it("stops polling after the callback fires", () => {
    const onParentGone = vi.fn();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw makeProcessError("ESRCH");
    });

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(20_000);

    expect(onParentGone).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("manual stop() halts polling", () => {
    const onParentGone = vi.fn();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      pollIntervalMs: 1000,
      onParentGone,
    });

    watcher.start();
    watcher.stop();
    vi.advanceTimersByTime(10_000);

    expect(killSpy).not.toHaveBeenCalled();
    expect(onParentGone).not.toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("does not start polling for invalid parent PIDs", () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const onParentGone = vi.fn();

    expect(() => new ParentPidWatcher({ parentPid: 0, onParentGone }).start()).toThrow(/parent pid/i);
    expect(() => new ParentPidWatcher({ parentPid: -1, onParentGone }).start()).toThrow(/parent pid/i);
    expect(() => new ParentPidWatcher({ parentPid: Number.NaN, onParentGone }).start()).toThrow(/parent pid/i);
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it("treats EPERM as parent-still-alive on macOS", () => {
    const onParentGone = vi.fn();
    setPlatform("darwin");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw makeProcessError("EPERM");
    });

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();
    vi.advanceTimersByTime(5000);

    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it("treats EPERM as parent-still-alive on Linux", () => {
    const onParentGone = vi.fn();
    setPlatform("linux");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw makeProcessError("EPERM");
    });

    const watcher = new ParentPidWatcher({
      parentPid: 4242,
      onParentGone,
    });

    watcher.start();
    vi.advanceTimersByTime(5000);

    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it("uses the same parent-death contract on Windows via watchParentAndExit", () => {
    setPlatform("win32");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw makeProcessError("ESRCH");
    });

    const watcher = watchParentAndExit(4242, 7);

    watcher.start();
    vi.advanceTimersByTime(5000);

    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
