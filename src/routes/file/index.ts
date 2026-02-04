import express from "express";
import {
  uploadFile,
  removeFile,
  syncAdd,
  syncFolder,
  createFolder,
  getContent,
  getStorageStats,
  downloadFile,
} from "../../controllers/file/index.js";
import { upload } from "../../config/multer.js";

const router = express.Router();

router.post("/upload", upload.single("file"), uploadFile);
router.delete("/remove", removeFile);
router.get("/download", downloadFile);

router.post("/folder/create", createFolder);
router.get("/content", getContent);
router.get("/stats", getStorageStats);

router.post("/sync-add", syncAdd);
router.post("/sync-folder", syncFolder);

export default router;
