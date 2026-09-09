export type SpaceType = "learn" | "review" | "ta";

export interface SpaceRow {
  id: number;
  type: SpaceType;
  name: string;
  created_at: string;
}

/** 只在服务端使用；HTTP 响应必须经过显式投影，不返回工作目录和 JSONL 路径。 */
export interface PiSessionRow {
  id: number;
  space_id: number;
  space_type: SpaceType;
  name: string | null;
  work_path: string;
  path: string;
  agents_md_id: number;
  teach_style_id: number | null;
  enable_make_card: number;
  review_topic_id: number | null;
  created_at: string;
}
