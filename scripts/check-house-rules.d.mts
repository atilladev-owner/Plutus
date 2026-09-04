export interface Violation {
  rule: string;
  file: string;
  line: number;
  excerpt: string;
}

export function checkTree(root: string): Violation[];
