// Task #4023 — kind → icon/tint mapping for file rows and cards.
import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";
import {
  classifyClientFileKind,
  type ClientFileKind,
} from "@shared/clientFiles";

const KIND_ICONS: Record<ClientFileKind, typeof File> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  other: File,
};

const KIND_TINTS: Record<ClientFileKind, string> = {
  image: "text-emerald-600 dark:text-emerald-400",
  video: "text-purple-600 dark:text-purple-400",
  audio: "text-amber-600 dark:text-amber-400",
  pdf: "text-red-600 dark:text-red-400",
  text: "text-slate-600",
  doc: "text-blue-600 dark:text-blue-400",
  sheet: "text-green-700 dark:text-green-400",
  slides: "text-orange-600 dark:text-orange-400",
  archive: "text-yellow-700 dark:text-yellow-400",
  other: "text-slate-500",
};

export function FileKindIcon({
  mimeType,
  fileName,
  className,
}: {
  mimeType: string;
  fileName?: string;
  className?: string;
}) {
  const kind = classifyClientFileKind(mimeType, fileName);
  const Icon = KIND_ICONS[kind] ?? File;
  return (
    <Icon
      className={`${className ?? "w-4 h-4"} ${KIND_TINTS[kind] ?? "text-slate-500"} shrink-0`}
    />
  );
}
