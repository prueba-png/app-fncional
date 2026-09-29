/** Tipos compartidos entre el cliente (React) y el servidor local (Express). */

/** Mapa ruta-relativa → contenido de texto. Ej: { "index.html": "...", "styles.css": "..." } */
export type FileMap = Record<string, string>;

export interface AssetRef {
  url: string;
  kind: "image" | "font" | "stylesheet" | "script" | "media" | "icon" | "other";
  /** Dónde se encontró: atributo HTML o url() dentro de CSS */
  origin: string;
}

export interface A11yIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  /** Fragmento del elemento afectado (truncado) */
  snippet?: string;
}

export interface OutlineNode {
  level: number;
  text: string;
}

export interface DomStats {
  totalElements: number;
  maxDepth: number;
  tagFrequency: Array<{ tag: string; count: number }>;
  landmarks: Array<{ role: string; count: number }>;
  forms: number;
  inputs: number;
  links: number;
  images: number;
  scripts: number;
  stylesheets: number;
  inlineStyles: number;
}

export interface CssStats {
  bytes: number;
  rules: number;
  mediaQueries: string[];
  customProperties: Array<{ name: string; value: string }>;
  colors: Array<{ value: string; count: number }>;
  fontFamilies: Array<{ value: string; count: number }>;
  fontSizes: Array<{ value: string; count: number }>;
  breakpoints: string[];
}

export interface DetectedDependency {
  id: string;
  name: string;
  /** Confianza de la detección 0..1 */
  confidence: number;
  /** Señales que dispararon la detección */
  evidence: string[];
  /** Ya está incluida en el HTML mediante <script>/<link> */
  included: boolean;
}

export interface IngestResult {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  title: string;
  description: string;
  lang: string;
  files: FileMap;
  assets: AssetRef[];
  outline: OutlineNode[];
  dom: DomStats;
  css: CssStats;
  a11y: A11yIssue[];
  dependencies: DetectedDependency[];
  warnings: string[];
  /** La página original apenas tiene contenido sin JavaScript (SPA): la réplica sin scripts saldría vacía */
  looksClientRendered: boolean;
}

export interface IngestOptions {
  url: string;
  /** Conservar los <script> de la página original (por defecto: false) */
  keepScripts?: boolean;
  /** Descargar e incrustar las hojas de estilo externas en styles.css (por defecto: true) */
  inlineStylesheets?: boolean;
}

/** Contenido multimodal que el cliente envía al asistente */
export type ChatAttachment =
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; label?: string }
  | { type: "pdf"; data: string; label?: string }
  | { type: "text"; text: string; label?: string };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  history: ChatTurn[];
  prompt: string;
  files: FileMap;
  activeFile?: string;
  attachments?: ChatAttachment[];
  mode?: "edit" | "generate-from-reference";
}

/** Eventos SSE emitidos por /api/llm/chat */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "status"; message: string }
  | { type: "done"; stopReason: string | null; usage?: { input: number; output: number }; model: string }
  | { type: "error"; message: string };

export interface TelegramCredentials {
  token: string;
  chatId: string;
}

export interface TelegramBackupResponse {
  messageId: number;
  fileId: string;
  fileUniqueId: string;
  fileSize: number;
  chatTitle?: string;
  date: number;
}

export interface TelegramTestResponse {
  bot: { id: number; username: string; firstName: string };
  chat: { id: number | string; title: string; type: string };
}
