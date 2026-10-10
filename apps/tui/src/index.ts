import React from "react";
import { render } from "ink";
import { App } from "./App.js";

export async function runTui(globals: string[] = []): Promise<number> {
  const instance = render(React.createElement(App, { globals }));
  await instance.waitUntilExit();
  return 0;
}
