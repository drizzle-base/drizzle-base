import type { MockDataSource } from "../src/mock";

declare global {
  interface Window {
    __dzbMock?: MockDataSource;
  }
}

declare module "*.css";
