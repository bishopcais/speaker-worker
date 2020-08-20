
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync} from 'fs';
import { join } from 'path';

export const cachePath = join(__dirname, '..', 'cache');

export function createCache(): void {
  if (!existsSync(cachePath)) {
    mkdirSync(cachePath);
  }
}

function clearDir(dirPath: string): void {
  const files = readdirSync(dirPath);

  for (let i = 0; i < files.length; i++) {
    const filePath = join(dirPath, files[i]);
    if (statSync(filePath).isDirectory()) {
      clearDir(filePath);
      rmdirSync(filePath);
    }
    else {
      unlinkSync(filePath);
    }
  }
}

export function clearCache(): void {
  if (!existsSync(cachePath)) {
    return;
  }
  clearDir(cachePath);
}
