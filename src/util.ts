import { networkInterfaces } from 'os';

export function getMacAddress(): string {
  const ifaces = networkInterfaces();
  for (const key in ifaces) {
    for (const iface of ifaces[key]) {
      if (!iface.internal) {
        return iface.mac;
      }
    }
  }
  return '00:00:00:00:00:00';
}
