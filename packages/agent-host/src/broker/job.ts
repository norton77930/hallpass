import koffi from "koffi";

/**
 * The broker's kill-on-close job (019 R-313, T524).
 *
 * The broker's first act, before it spawns anything: create a Windows job object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, put the broker itself in it, and keep the handle for the
 * life of the process. Every agent, adapter, tool and their children inherit membership, and the
 * handle is never shared, so it closes when the broker ends by any means - a crash or a hard kill
 * included - and Windows ends the whole tree. That covers the two shapes Node's own per-process job
 * lets escape (measured 2026-10-18): a child started through `cmd.exe` and a `detached` grandchild.
 * The broker's graceful shutdown (R-312) is the first layer; this is the backstop.
 *
 * Three Win32 calls through koffi (owner's choice, R-313 option A). Any failure throws: the broker
 * logs the reason and exits rather than running agents unprotected.
 */

/** `JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation`. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export type KillOnCloseJob = {
  /** Whether Windows reports `pid` as a member of this job (`IsProcessInJob`); false for no such process. */
  contains: (pid: number) => boolean;
};

type Kernel32 = {
  CreateJobObjectW: (attributes: null, name: null) => unknown;
  SetInformationJobObject: (job: unknown, infoClass: number, info: unknown, length: number) => boolean;
  AssignProcessToJobObject: (job: unknown, process: unknown) => boolean;
  GetCurrentProcess: () => unknown;
  GetLastError: () => number;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  IsProcessInJob: (process: unknown, job: unknown, result: number[]) => boolean;
  CloseHandle: (handle: unknown) => boolean;
};

let kernel32: { api: Kernel32; extendedLimitInformation: ReturnType<typeof koffi.struct> } | undefined;

function bind(): NonNullable<typeof kernel32> {
  if (kernel32 !== undefined) return kernel32;
  const library = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
  const basic = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const io = koffi.struct("IO_COUNTERS", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const extendedLimitInformation = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });
  const api: Kernel32 = {
    CreateJobObjectW: library.func("__stdcall", "CreateJobObjectW", HANDLE, ["void *", "void *"]),
    SetInformationJobObject: library.func("__stdcall", "SetInformationJobObject", "bool", [
      HANDLE,
      "int",
      koffi.pointer(extendedLimitInformation),
      "uint32",
    ]),
    AssignProcessToJobObject: library.func("__stdcall", "AssignProcessToJobObject", "bool", [HANDLE, HANDLE]),
    GetCurrentProcess: library.func("__stdcall", "GetCurrentProcess", HANDLE, []),
    GetLastError: library.func("__stdcall", "GetLastError", "uint32", []),
    OpenProcess: library.func("__stdcall", "OpenProcess", HANDLE, ["uint32", "bool", "uint32"]),
    IsProcessInJob: library.func("__stdcall", "IsProcessInJob", "bool", [HANDLE, HANDLE, koffi.out(koffi.pointer("int"))]),
    CloseHandle: library.func("__stdcall", "CloseHandle", "bool", [HANDLE]),
  };
  kernel32 = { api, extendedLimitInformation };
  return kernel32;
}

/**
 * Held for the life of the process and never closed: closing it is exactly what ends the tree, and
 * that must happen only when the broker itself is gone.
 */
let held: unknown;

/** Creates the job, sets kill-on-close, assigns this process. Throws with the failing step named. */
export function createKillOnCloseJob(): KillOnCloseJob {
  if (process.platform !== "win32") throw new Error("job: windows only");
  const { api, extendedLimitInformation } = bind();
  const job = api.CreateJobObjectW(null, null);
  if (job === null || job === undefined || job === 0n) throw new Error(`job: create failed (${api.GetLastError()})`);
  const info = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
  if (
    !api.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
      info,
      koffi.sizeof(extendedLimitInformation),
    )
  ) {
    const error = api.GetLastError();
    api.CloseHandle(job);
    throw new Error(`job: set kill-on-close failed (${error})`);
  }
  if (!api.AssignProcessToJobObject(job, api.GetCurrentProcess())) {
    const error = api.GetLastError();
    api.CloseHandle(job);
    throw new Error(`job: assign failed (${error})`);
  }
  held = job;
  return {
    contains(pid) {
      const target = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (target === null || target === undefined || target === 0n) return false;
      try {
        const result = [0];
        return api.IsProcessInJob(target, held, result) && result[0] !== 0;
      } finally {
        api.CloseHandle(target);
      }
    },
  };
}
