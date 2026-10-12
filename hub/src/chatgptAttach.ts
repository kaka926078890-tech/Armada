export type ChatgptTargetView = { root: string; label: string; ready: boolean };

export type ChatgptMachineView = {
  port: "absent" | "down" | "ready";
  targets: { root: string; label: string }[];
};

export const CHATGPT_LOCAL_MACHINE = "chatgpt-local";

export function sameHost(machineName: string, hostName: string): boolean {
  const a = machineName.toLowerCase().split(".")[0] ?? "";
  const b = hostName.toLowerCase().split(".")[0] ?? "";
  return a.length > 0 && a === b;
}

type MachineLike = {
  id: string;
  name: string;
  os: string;
  status: string;
  chatgpt_workspaces?: ChatgptTargetView[];
  chatgpt_port?: "absent" | "down" | "ready";
};

/** ChatGPT 列挂在本机。Cursor 在线时并进那一台；不在线时单独用本机行。Windows 不加。 */
export function attachChatgpt<T extends MachineLike>(machines: T[], view: ChatgptMachineView, hostName: string): T[] {
  const withoutLocal = machines.filter((machine) => machine.id !== CHATGPT_LOCAL_MACHINE);
  if (view.port === "absent") return withoutLocal;
  const local = withoutLocal.filter((machine) => machine.os.startsWith("darwin") && sameHost(machine.name, hostName));
  const online = local.find((machine) => machine.status === "online");
  const hostId = online?.id ?? CHATGPT_LOCAL_MACHINE;
  const targets: ChatgptTargetView[] = view.port === "ready"
    ? view.targets.map((item) => ({ ...item, ready: true }))
    : [{ root: "chatgpt:monitor", label: "需要用监控启动", ready: false }];
  const rows = hostId === CHATGPT_LOCAL_MACHINE
    ? machines.map((machine) => machine.id === CHATGPT_LOCAL_MACHINE
      ? { ...machine, status: "online", os: machine.os || "darwin", name: machine.name || hostName }
      : machine)
    : withoutLocal;
  return rows.map((machine) => {
    if (machine.id !== hostId) return machine;
    return { ...machine, chatgpt_workspaces: targets, chatgpt_port: view.port };
  });
}
