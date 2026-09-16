export type AuthLossAction = "ask-host" | "logout";

export function decideAuthLoss(desktop: boolean): AuthLossAction {
  return desktop ? "ask-host" : "logout";
}
