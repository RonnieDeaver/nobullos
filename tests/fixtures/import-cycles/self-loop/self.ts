import { self as again } from "./self";
export const self = 1;
export const echoed: typeof again = again;
