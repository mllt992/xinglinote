import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env } from "../env.ts";

export function notePath(workspaceId: string, notebookId: string, noteId: string) {
  return join(env.dataDir, "workspaces", workspaceId, "notes", notebookId, `${noteId}.md`);
}

export async function writeNoteFile(input: {
  workspaceId: string;
  notebookId: string;
  noteId: string;
  title: string;
  bodyMd: string;
  published: boolean;
  aiIndex: boolean;
}) {
  const file = notePath(input.workspaceId, input.notebookId, input.noteId);
  await mkdir(dirname(file), { recursive: true });
  const md = `---\nid: ${input.noteId}\ntitle: ${JSON.stringify(input.title)}\npublished: ${input.published}\nai_index: ${input.aiIndex}\n---\n\n${input.bodyMd}`;
  await writeFile(file, md, "utf8");
}
