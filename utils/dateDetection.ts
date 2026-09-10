// utils/dateDetection.ts

export type DetectedTargetDate = {
  targetDate: Date;
  label: string;
  matchedText: string;
  confidence: number;
};

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Parses time expressions like "3:30 pm", "5pm", "14:00", "at 9 am", "at 9"
 */
function parseTimeIntoDate(target: Date, text: string): boolean {
  // Requires either:
  // 1) "at <hour>[:<minute>] [am|pm]"
  // 2) "<hour>:<minute> [am|pm]"
  // 3) "<hour> [am|pm]"
  const timeRegex = /(?:at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b)|(?:\b(\d{1,2}):(\d{2})\s*(am|pm)?\b)|(?:\b(\d{1,2})\s*(am|pm)\b)/i;
  const match = text.match(timeRegex);
  if (!match) return false;

  let hour = 0;
  let minute = 0;
  let meridiem: string | undefined;

  if (match[1] !== undefined) {
    // Branch 1: "at 9", "at 3:30 pm", "at 5pm"
    hour = parseInt(match[1], 10);
    minute = match[2] ? parseInt(match[2], 10) : 0;
    meridiem = match[3]?.toLowerCase();
  } else if (match[4] !== undefined) {
    // Branch 2: "14:00", "3:30 pm"
    hour = parseInt(match[4], 10);
    minute = parseInt(match[5], 10);
    meridiem = match[6]?.toLowerCase();
  } else if (match[7] !== undefined) {
    // Branch 3: "5pm", "9 am"
    hour = parseInt(match[7], 10);
    minute = 0;
    meridiem = match[8]?.toLowerCase();
  }

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
    target.setHours(hour, minute, 0, 0);
    return true;
  }
  return false;
}

/**
 * Scans text for upcoming target dates, event deadlines, or schedules.
 * Returns the detected Date object, formatted label, and confidence.
 */
export function detectAnnouncementTargetDate(
  content: string,
  now: Date = new Date(),
): DetectedTargetDate | null {
  if (!content || typeof content !== "string") return null;

  const normalized = content.toLowerCase();

  // 1. Check for "tomorrow"
  if (/\btomorrow\b/i.test(normalized)) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    const hasTime = parseTimeIntoDate(target, normalized);
    if (!hasTime) {
      target.setHours(23, 59, 0, 0); // End of day default
    }
    if (target.getTime() > now.getTime()) {
      return {
        targetDate: target,
        label: formatTargetDateLabel(target),
        matchedText: "tomorrow",
        confidence: 0.95,
      };
    }
  }

  // 2. Month + Day (e.g., "October 15", "Oct 15, 2026", "15 October", "on Oct 15th")
  const monthDayRegex =
    /\b(?:on\s+|by\s+|until\s+|deadline:?\s*)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i;
  const mdMatch = normalized.match(monthDayRegex);

  if (mdMatch) {
    const monthKey = mdMatch[1].toLowerCase();
    const monthIndex = MONTH_NAMES[monthKey];
    const day = parseInt(mdMatch[2], 10);
    const currentYear = now.getFullYear();
    const year = mdMatch[3] ? parseInt(mdMatch[3], 10) : currentYear;

    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      const target = new Date(year, monthIndex, day, 23, 59, 0, 0);

      // If no year specified and date is already past, assume next year
      if (!mdMatch[3] && target.getTime() < now.getTime()) {
        target.setFullYear(currentYear + 1);
      }

      // Check if time is specified near the date
      parseTimeIntoDate(target, normalized);

      if (target.getTime() > now.getTime()) {
        return {
          targetDate: target,
          label: formatTargetDateLabel(target),
          matchedText: mdMatch[0].trim(),
          confidence: 0.9,
        };
      }
    }
  }

  // 3. Day + Month (e.g., "15th of October", "15 Oct 2026")
  const dayMonthRegex =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\.?(?:,?\s*(\d{4}))?\b/i;
  const dmMatch = normalized.match(dayMonthRegex);

  if (dmMatch) {
    const day = parseInt(dmMatch[1], 10);
    const monthKey = dmMatch[2].toLowerCase();
    const monthIndex = MONTH_NAMES[monthKey];
    const currentYear = now.getFullYear();
    const year = dmMatch[3] ? parseInt(dmMatch[3], 10) : currentYear;

    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      const target = new Date(year, monthIndex, day, 23, 59, 0, 0);
      if (!dmMatch[3] && target.getTime() < now.getTime()) {
        target.setFullYear(currentYear + 1);
      }
      parseTimeIntoDate(target, normalized);

      if (target.getTime() > now.getTime()) {
        return {
          targetDate: target,
          label: formatTargetDateLabel(target),
          matchedText: dmMatch[0].trim(),
          confidence: 0.9,
        };
      }
    }
  }

  // 4. Day of the week (e.g. "this Friday", "next Monday", "by Wednesday")
  const dayOfWeekRegex =
    /\b(?:this\s+|next\s+|by\s+|until\s+|on\s+)?(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/i;
  const dowMatch = normalized.match(dayOfWeekRegex);

  if (dowMatch) {
    const dayKey = dowMatch[1].toLowerCase();
    const targetDayIndex = DAY_NAMES[dayKey];

    if (targetDayIndex !== undefined) {
      const currentDayIndex = now.getDay();
      let diff = targetDayIndex - currentDayIndex;
      if (diff <= 0) diff += 7; // Next occurrence

      const target = new Date(now);
      target.setDate(now.getDate() + diff);
      const hasTime = parseTimeIntoDate(target, normalized);
      if (!hasTime) {
        target.setHours(23, 59, 0, 0);
      }

      if (target.getTime() > now.getTime()) {
        return {
          targetDate: target,
          label: formatTargetDateLabel(target),
          matchedText: dowMatch[0].trim(),
          confidence: 0.85,
        };
      }
    }
  }

  // 5. Numeric formats: MM/DD/YYYY or YYYY-MM-DD
  const numericRegex = /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b|\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
  const numMatch = normalized.match(numericRegex);

  if (numMatch) {
    let year = 0;
    let month = 0;
    let day = 0;

    if (numMatch[1]) {
      // YYYY-MM-DD
      year = parseInt(numMatch[1], 10);
      month = parseInt(numMatch[2], 10) - 1;
      day = parseInt(numMatch[3], 10);
    } else {
      // MM/DD/YYYY
      month = parseInt(numMatch[4], 10) - 1;
      day = parseInt(numMatch[5], 10);
      year = parseInt(numMatch[6], 10);
    }

    if (month >= 0 && month <= 11 && day >= 1 && day <= 31 && year >= now.getFullYear()) {
      const target = new Date(year, month, day, 23, 59, 0, 0);
      parseTimeIntoDate(target, normalized);
      if (target.getTime() > now.getTime()) {
        return {
          targetDate: target,
          label: formatTargetDateLabel(target),
          matchedText: numMatch[0].trim(),
          confidence: 0.85,
        };
      }
    }
  }

  return null;
}

export function formatTargetDateLabel(date: Date): string {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const isEndOfDay = (hours === 23 && minutes === 59) || (hours === 0 && minutes === 0);

  if (isEndOfDay) {
    return `${month} ${day}, ${year}`;
  }

  const meridiem = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  const displayMinutes = minutes < 10 ? `0${minutes}` : `${minutes}`;

  return `${month} ${day}, ${year} at ${displayHours}:${displayMinutes} ${meridiem}`;
}
