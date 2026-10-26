export function mentionsUser(body: string, name: string): boolean;
export function splitMentions(
  text: string,
  names: string[],
): { type: "text" | "mention"; value: string; name?: string }[];
