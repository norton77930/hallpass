export type Clock = {
  now(): Date;
};

export function systemClock(): Clock {
  return { now: () => new Date() };
}

export function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  return { now: () => date };
}
