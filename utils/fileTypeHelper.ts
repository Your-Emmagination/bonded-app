// utils/fileTypeHelper.ts
import { Ionicons } from "@expo/vector-icons";

export interface FileIconDetails {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  badge: string;
  category: "pdf" | "word" | "powerpoint" | "excel" | "text" | "archive" | "file";
}

/**
 * Returns UI details (icon, color, badge, category) for any file based on its MIME type and filename.
 */
export function getFileIconDetails(mimeType: string = "", fileName: string = ""): FileIconDetails {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  // PDF
  if (lowerMime.includes("pdf") || lowerName.endsWith(".pdf")) {
    return {
      icon: "document-text",
      color: "#e74c3c",
      badge: "PDF",
      category: "pdf",
    };
  }

  // Word / Docs
  if (
    lowerMime.includes("word") ||
    lowerMime.includes("document") ||
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".odt") ||
    lowerName.endsWith(".rtf")
  ) {
    return {
      icon: "document",
      color: "#2980b9",
      badge: "DOC",
      category: "word",
    };
  }

  // PowerPoint / Presentations
  if (
    lowerMime.includes("presentation") ||
    lowerMime.includes("powerpoint") ||
    lowerName.endsWith(".ppt") ||
    lowerName.endsWith(".pptx") ||
    lowerName.endsWith(".odp") ||
    lowerName.endsWith(".key")
  ) {
    return {
      icon: "easel",
      color: "#d35400",
      badge: "PPT",
      category: "powerpoint",
    };
  }

  // Excel / Spreadsheets
  if (
    lowerMime.includes("sheet") ||
    lowerMime.includes("excel") ||
    lowerName.endsWith(".xls") ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".ods")
  ) {
    return {
      icon: "grid",
      color: "#27ae60",
      badge: "XLS",
      category: "excel",
    };
  }

  // Text files
  if (
    lowerMime.includes("text") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json")
  ) {
    return {
      icon: "document-text-outline",
      color: "#7f8c8d",
      badge: "TXT",
      category: "text",
    };
  }

  // Archives / Zip
  if (
    lowerMime.includes("zip") ||
    lowerMime.includes("tar") ||
    lowerMime.includes("archive") ||
    lowerName.endsWith(".zip") ||
    lowerName.endsWith(".rar") ||
    lowerName.endsWith(".7z") ||
    lowerName.endsWith(".tar") ||
    lowerName.endsWith(".gz")
  ) {
    return {
      icon: "archive-outline",
      color: "#8e44ad",
      badge: "ZIP",
      category: "archive",
    };
  }

  // Generic fallback
  return {
    icon: "document-attach-outline",
    color: "#4f9cff",
    badge: "FILE",
    category: "file",
  };
}
