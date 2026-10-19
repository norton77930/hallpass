import koffi from "koffi";

/**
 * The browser's main process, as the broker finds and watches it (019 T575, D-019-14, R-330).
 *
 * Chrome starts the native host through `cmd.exe /d /s /c "<launcher>"` (measured on branded Chrome:
 * relay `node.exe` <- `cmd.exe` <- `chrome.exe` without `--type`, the browser's main process), and
 * the relay starts the broker. So from the broker: its parent is the relay, then zero or more
 * launcher shells, then the browser. A parent created after its child is a pid Windows reused, not
 * the parent: the browser is then not known, and the broker keeps the plain relay window.
 *
 * The broker finds it once, at start, while the relay that spawned it is still there, and opens a
 * handle to it right away: a held handle keeps the pid from being reused, so the watch can never
 * mistake a newcomer for the browser. Polling that handle (`WaitForSingleObject`, no wait) is one
 * cheap call. Win32 through koffi, as the job (`job.ts`); the relay itself never loads koffi.
 */

export type ProcessFacts = {
  parentPid: number;
  /** The image name, e.g. `cmd.exe`. */
  exe: string;
  /** `GetProcessTimes` creation time, 100 ns since 1601. */
  createdAt: bigint;
};

export type BrowserProcess = { pid: number; createdAt: bigint };

/** Hops from the relay to the browser, at most; the launcher adds one `cmd.exe`. */
const MAX_SHELLS = 3;

/** The browser above `selfPid`'s relay, or `undefined` when the chain is broken or a pid was reused. */
export function findBrowserAncestor(
  selfPid: number,
  lookup: (pid: number) => ProcessFacts | undefined,
): BrowserProcess | undefined {
  let child = lookup(selfPid);
  if (child === undefined) return undefined;
  // The relay, whatever its image; then the launcher shells; then the browser.
  for (let hop = 0; hop <= MAX_SHELLS + 1; hop += 1) {
    const pid = child.parentPid;
    const parent = lookup(pid);
    if (parent === undefined || parent.createdAt > child.createdAt) return undefined;
    if (hop > 0 && parent.exe.toLowerCase() !== "cmd.exe") return { pid, createdAt: parent.createdAt };
    child = parent;
  }
  return undefined;
}

export type BrowserWatch = { pid: number; isGone: () => boolean };

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_OBJECT_0 = 0;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;

type Kernel32 = {
  CreateToolhelp32Snapshot: (flags: number, pid: number) => unknown;
  Process32FirstW: (snapshot: unknown, entry: Record<string, unknown>) => boolean;
  Process32NextW: (snapshot: unknown, entry: Record<string, unknown>) => boolean;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  GetProcessTimes: (process: unknown, created: bigint[], exited: bigint[], kernel: bigint[], user: bigint[]) => boolean;
  WaitForSingleObject: (handle: unknown, ms: number) => number;
  CloseHandle: (handle: unknown) => boolean;
};

let kernel32: { api: Kernel32; entrySize: number } | undefined;

function bind(): NonNullable<typeof kernel32> {
  if (kernel32 !== undefined) return kernel32;
  const library = koffi.load("kernel32.dll");
  // Unnamed: `job.ts` names its own HANDLE type, and koffi refuses a second type of that name.
  const handle = koffi.pointer(koffi.opaque());
  const entry = koffi.struct("HALLPASS_PROCESSENTRY32W", {
    dwSize: "uint32",
    cntUsage: "uint32",
    th32ProcessID: "uint32",
    th32DefaultHeapID: "uintptr_t",
    th32ModuleID: "uint32",
    cntThreads: "uint32",
    th32ParentProcessID: "uint32",
    pcPriClassBase: "int32",
    dwFlags: "uint32",
    szExeFile: koffi.array("char16_t", 260, "String"),
  });
  const filetime = koffi.out(koffi.pointer("uint64_t"));
  const api: Kernel32 = {
    CreateToolhelp32Snapshot: library.func("__stdcall", "CreateToolhelp32Snapshot", handle, ["uint32", "uint32"]),
    Process32FirstW: library.func("__stdcall", "Process32FirstW", "bool", [handle, koffi.inout(koffi.pointer(entry))]),
    Process32NextW: library.func("__stdcall", "Process32NextW", "bool", [handle, koffi.inout(koffi.pointer(entry))]),
    OpenProcess: library.func("__stdcall", "OpenProcess", handle, ["uint32", "bool", "uint32"]),
    GetProcessTimes: library.func("__stdcall", "GetProcessTimes", "bool", [handle, filetime, filetime, filetime, filetime]),
    WaitForSingleObject: library.func("__stdcall", "WaitForSingleObject", "uint32", [handle, "uint32"]),
    CloseHandle: library.func("__stdcall", "CloseHandle", "bool", [handle]),
  };
  kernel32 = { api, entrySize: koffi.sizeof(entry) };
  return kernel32;
}

const isNull = (handle: unknown): boolean => handle === null || handle === undefined || handle === 0n;

/** Every process's parent and image name, from one Toolhelp snapshot. */
function snapshotParents(api: Kernel32, entrySize: number): Map<number, { parentPid: number; exe: string }> {
  const parents = new Map<number, { parentPid: number; exe: string }>();
  const snapshot = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (isNull(snapshot) || koffi.address(snapshot) === INVALID_HANDLE_VALUE) return parents;
  try {
    const entry: Record<string, unknown> = { dwSize: entrySize };
    for (let more = api.Process32FirstW(snapshot, entry); more; more = api.Process32NextW(snapshot, entry)) {
      parents.set(entry.th32ProcessID as number, {
        parentPid: entry.th32ParentProcessID as number,
        exe: String(entry.szExeFile),
      });
      entry.dwSize = entrySize;
    }
  } finally {
    api.CloseHandle(snapshot);
  }
  return parents;
}

/** The creation time of an open process handle, or `undefined`. */
function creationTime(api: Kernel32, handle: unknown): bigint | undefined {
  const created = [0n];
  const unused = [0n];
  if (!api.GetProcessTimes(handle, created, [0n], unused, [0n])) return undefined;
  return BigInt(created[0]!);
}

function createdAtOf(api: Kernel32, pid: number): bigint | undefined {
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (isNull(handle)) return undefined;
  try {
    return creationTime(api, handle);
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * Finds the browser above this broker and holds a handle to it, or `undefined` when it cannot be
 * known (not Windows, a broken chain, a reused pid, a failed call): the caller keeps the plain window.
 */
export function watchBrowserProcess(selfPid: number = process.pid): BrowserWatch | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const { api, entrySize } = bind();
    const parents = snapshotParents(api, entrySize);
    const browser = findBrowserAncestor(selfPid, (pid) => {
      const facts = parents.get(pid);
      if (facts === undefined) return undefined;
      const createdAt = createdAtOf(api, pid);
      return createdAt === undefined ? undefined : { ...facts, createdAt };
    });
    if (browser === undefined) return undefined;
    const handle = api.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, browser.pid);
    if (isNull(handle)) return undefined;
    // Between the walk and this handle the pid could have been reused: then it is not the browser.
    if (creationTime(api, handle) !== browser.createdAt) {
      api.CloseHandle(handle);
      return undefined;
    }
    // Held for the life of the broker, never closed: it is what keeps the pid the browser's.
    return { pid: browser.pid, isGone: () => api.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0 };
  } catch {
    return undefined;
  }
}
