import express from 'express';
import { uploadFile, removeFile, syncDelete, syncAdd } from "../../controllers/file/index.js";
import { upload } from "../../config/multer.js";
const router = express.Router();
// 'file' tendrá que ser el nombre del campo que vendrá desde el FormData del React
router.post('/upload', upload.single('file'), uploadFile);
router.delete('/sync-delete', syncDelete);
router.post('/sync-add', syncAdd);
router.delete('/remove', removeFile);
export default router;
