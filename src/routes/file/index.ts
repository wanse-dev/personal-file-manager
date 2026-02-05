import express from "express";
import {
  uploadFile,
  removeFile,
  syncUpsertFile,
  syncRemove,
  syncFolder,
  removeFolderSync,
  createFolder,
  removeFolder,
  getContent,
  getStorageStats,
  syncMove,
  downloadFile,
} from "../../controllers/file/index.js";
import { upload } from "../../config/multer.js";

const router = express.Router();

router.post("/upload", upload.single("file"), uploadFile);
router.delete("/remove", removeFile);
router.get("/download", downloadFile);

router.post("/folder/create", createFolder);
router.delete("/folder/remove", removeFolder);
router.get("/content", getContent);
router.get("/stats", getStorageStats);

router.post("/sync-upsert-file", syncUpsertFile);
router.delete("/sync-remove", syncRemove);
router.post("/sync-folder", syncFolder);
router.delete("/sync-folder-delete", removeFolderSync);
router.post("/sync-move", syncMove);

export default router;
