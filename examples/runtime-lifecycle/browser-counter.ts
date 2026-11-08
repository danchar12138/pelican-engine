import { strToU8, zlibSync } from "fflate";

// Deliberately browser-only module initialization: the compiler must not execute it.
const ownerDocument = document;
export function createCounterView() {
  const output = ownerDocument.createElement("output");
  output.dataset.pelicanCounter = "";
  ownerDocument.body.append(output);
  return {
    show(ticks: number) {
      const bytes = zlibSync(strToU8(JSON.stringify({ ticks })));
      output.textContent = `${ticks} ticks (${bytes.length} compressed bytes)`;
    },
    dispose() { output.remove(); },
  };
}
