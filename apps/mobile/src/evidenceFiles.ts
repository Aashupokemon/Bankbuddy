/**
 * Where held photos actually live on the phone: the app's own files directory, not the gallery.
 *
 * Files are named by the queue operation's id, so a photo can be found again after a restart and a
 * sync can delete exactly the bytes it uploaded.
 */

import * as FileSystem from "expo-file-system";

import type { EvidenceStore } from "./evidence";

function directory(): string | null {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}evidence/` : null;
}

export const fileEvidenceStore: EvidenceStore = {
  async save(id, dataBase64) {
    const dir = directory();
    if (!dir) throw new Error("This phone has nowhere to keep the photo.");
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    const uri = `${dir}${id}`;
    await FileSystem.writeAsStringAsync(uri, dataBase64, { encoding: FileSystem.EncodingType.Base64 });
    return uri;
  },

  async read(id) {
    const dir = directory();
    if (!dir || !id) return null;
    const uri = `${dir}${id}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  },

  async remove(id) {
    const dir = directory();
    if (!dir || !id) return;
    await FileSystem.deleteAsync(`${dir}${id}`, { idempotent: true }).catch(() => undefined);
  },
};
