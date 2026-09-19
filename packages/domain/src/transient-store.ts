export type TransientRecord<T> = {
  key: string;
  value: T;
};

export class MemoryTransientStore<T> {
  private readonly records = new Map<string, T>();

  get(key: string): T | undefined {
    return this.records.get(key);
  }

  set(key: string, value: T): void {
    this.records.set(key, value);
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  clear(): void {
    this.records.clear();
  }
}
