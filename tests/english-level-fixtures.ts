import { join } from "node:path";
import type { EnglishLevelSourceInput } from "../src/english-levels";
import type { EnglishSourceInput } from "../src/english-rebuild";
import { createStoredZip } from "../src/stored-zip";

export const cefrj = "headword,pos,CEFR,CoreInventory 1,CoreInventory 2,Threshold\r\n" +
  "run,noun,A2,,,\r\nrun,verb,A1,,,\r\nrich,adjective,A1,,,\r\ncolor/colour,noun,A1,\"Colours, shapes\",,\r\n";
export const octanove = "headword,pos,CEFR,notes\r\n" +
  "rich,adjective,C1,containing a lot of fat/flavor\r\ntimid,adjective,C1,\r\nturn to ,verb,C1,\r\n";

export async function levelSources(root: string): Promise<EnglishLevelSourceInput[]> {
  await Bun.write(join(root, "cefrj.csv"), cefrj);
  await Bun.write(join(root, "octanove.csv"), octanove);
  return [
    {
      source: "cefr-j",
      version: "1.5",
      file: join(root, "cefrj.csv"),
      license: "LicenseRef-CEFR-J-Wordlist",
      attribution: "The CEFR-J Wordlist Version 1.5"
    },
    {
      source: "octanove",
      version: "1.0",
      file: join(root, "octanove.csv"),
      license: "CC-BY-SA-4.0",
      attribution: "Octanove Vocabulary Profile C1/C2"
    }
  ];
}

export async function fixtureWordNet(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "wordnet.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        run: { n: { sense: [{ id: "run%1:04:00::", synset: "s-run" }] } },
        colour: { n: { sense: [{ id: "colour%1:07:00::", synset: "s-colour" }] } },
        timid: { a: { sense: [{ id: "timid%3:00:00::", synset: "s-timid" }] } },
        ubiquitous: { a: { sense: [{ id: "ubiquitous%3:00:00::", synset: "s-ubiquitous" }] } }
      })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "s-run": { definition: ["a score in baseball"], members: ["run"], partOfSpeech: "n" },
        "s-colour": { definition: ["a visual attribute of things"], members: ["colour"], partOfSpeech: "n" }
      })
    },
    {
      name: "adj.fixture.json",
      content: JSON.stringify({
        "s-timid": { definition: ["showing a lack of courage"], members: ["timid"], partOfSpeech: "a" },
        "s-ubiquitous": { definition: ["being present everywhere at once"], members: ["ubiquitous"], partOfSpeech: "a" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2025-fixture", file };
}
