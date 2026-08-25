import { a } from "./a";
export const c = () => (a as unknown as () => number)() + 1;
