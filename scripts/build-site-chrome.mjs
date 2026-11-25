import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL(".", import.meta.resolve("@4seas/site-chrome"));
const destination = new URL("../public/passport/site-chrome/", import.meta.url);
await mkdir(destination, { recursive: true });
const interaction = await readFile(new URL("interaction.js", source), "utf8");
await Promise.all([
  copyFile(new URL("assets/logo.png", source), new URL("logo.png", destination)),
  copyFile(new URL("style.css", source), new URL("style.css", destination)),
  writeFile(
    new URL("chrome.js", destination),
    interaction + '\nfor (const header of document.querySelectorAll(".fs-header")) mountHeader(header);\n',
  ),
]);
