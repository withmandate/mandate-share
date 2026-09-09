import runtimePackage from "../package.json";

export interface StoreContext {
  /** Stable opaque identifier from this store's marker; independent of its registry name. */
  id: string;
  name: string;
  root: string;
  runtimeRoot: string;
  stateDir: string;
  outDir: string;
}

export const VERSION = runtimePackage.version;
