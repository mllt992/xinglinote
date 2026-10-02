import { useEffect, useState } from "react";
import { deviceStorage } from "./device-storage";

/** 账号识别、同页退出、跨标签页退出都立即使页面作用域失效。 */
export function subscribeDeviceAccount(target: EventTarget, sync: () => void) {
  for (const event of ["kb:device-storage", "storage", "focus"]) target.addEventListener(event, sync);
  return () => { for (const event of ["kb:device-storage", "storage", "focus"]) target.removeEventListener(event, sync); };
}
export function useDeviceAccountKey() {
  const read = () => `${deviceStorage.epoch()}:${deviceStorage.identity() ?? ""}`;
  const [key, setKey] = useState(read);
  useEffect(() => {
    const sync = () => setKey(read());
    const unsubscribe = subscribeDeviceAccount(window, sync);
    sync();
    return unsubscribe;
  }, []);
  return key;
}
