export type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
};

export function createFakeChrome(tab: FakeTab): {
  runtime: { id: string };
  tabs: { get: (id: number) => Promise<FakeTab> };
} {
  return {
    runtime: { id: "adgpccmmbgnchnphfaoabfflfcepbopd" },
    tabs: {
      async get(id: number) {
        if (id !== tab.id) {
          throw new Error("unknown tab");
        }
        return tab;
      },
    },
  };
}
