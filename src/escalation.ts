import { Route } from "./types";

const solMedium: Route = { worker: "sol", effort: "medium", label: "sol-medium" };

// One retry at the current level; a Luna task then gets two attempts with Sol.
export function nextRoute(initial: Route, failedAttempts: number): Route | null {
  if (initial.worker === "luna") {
    if (failedAttempts === 1) return initial;
    if (failedAttempts === 2 || failedAttempts === 3) return solMedium;
    return null;
  }

  return failedAttempts === 1 ? initial : null;
}
