/** 设计 26：仅包含可读内容的聚合结果，不传正文或不可见对象的计数。 */
export type AnalyticsDay = { date: string; created: number; edited: number; versions: number };
export type AnalyticsNotebook = { id: string; title: string; notes: number; characters: number; edited: number };
export type AnalyticsDistribution = { id: string; title: string; notes: number };
export type WorkspaceAnalytics = {
  workspace: { id: string; name: string; kind: string; role: string; frozen: boolean };
  scope: { notebookId: string | null; title: string; days: 7 | 30; from: string; through: string; timezone: "UTC" };
  generatedAt: string;
  summary: {
    notebooks: number; notes: number; folders: number; characters: number;
    attachments: number; images: number; attachmentBytes: number; published: number;
    created: number; edited: number; versions: number;
    links: number; connectedNotes: number; isolatedNotes: number; tasks: number; tasksDone: number;
  };
  trend: AnalyticsDay[];
  notebooks: AnalyticsNotebook[];
  folders: AnalyticsDistribution[];
  folderOtherNotes: number;
  tags: AnalyticsDistribution[];
};
