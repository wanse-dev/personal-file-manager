import { sequelize } from "../../database.js";
import { bucket } from "../../config/firebase.js";
import { QueryTypes } from "sequelize";
import axios from "axios";
import FormData from "form-data";
// --- helpers ---
const getBridgeUrl = () => process.env.BRIDGE_URL?.replace("/upload-bridge", "") || "";
const getHeaders = (form) => ({
    ...(form ? form.getHeaders() : {}),
    "bypass-tunnel-reminder": "true",
    "cf-skip-browser-warning": "true",
});
// --- upload y remove físicos ---
export const uploadFile = async (req, res) => {
    try {
        const file = req.file;
        let { location, uid_user } = req.body;
        if (!file || !location || !uid_user)
            return res.status(400).json({ message: "missing data" });
        // revisa si el archivo ya existe para el usuario
        const existingFile = await sequelize.query("SELECT id_file FROM files WHERE original_name = :name AND uid_user = :uid LIMIT 1", {
            replacements: { name: file.originalname, uid: uid_user },
            type: QueryTypes.SELECT,
        });
        if (existingFile.length > 0) {
            return res.status(409).json({
                success: false,
                message: "file already exists",
            });
        }
        // revisa si el bridge local esta activo
        if (location === "local") {
            try {
                await axios.get(`${getBridgeUrl()}/ping`, { timeout: 2000 });
            }
            catch (err) {
                location = "cloud";
            }
        }
        const category = file.mimetype.startsWith("image/")
            ? "image"
            : file.mimetype.startsWith("video/")
                ? "video"
                : "binary";
        const extension = file.originalname.split(".").pop() || "bin";
        let finalPath = "";
        // upload del archivo fisico
        if (location === "local") {
            const form = new FormData();
            form.append("file", file.buffer, {
                filename: file.originalname,
                contentType: file.mimetype,
            });
            const { data } = await axios.post(`${process.env.BRIDGE_URL}/upload-bridge`, form, {
                headers: getHeaders(form),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            finalPath = data.path;
        }
        else {
            const fileName = `uploads/${uid_user}/${Date.now()}-${file.originalname}`;
            const blob = bucket.file(fileName);
            const stream = blob.createWriteStream({
                metadata: { contentType: file.mimetype },
                resumable: false,
            });
            finalPath = await new Promise((resolve, reject) => {
                stream.on("error", reject);
                stream.on("finish", async () => {
                    await blob.makePublic();
                    resolve(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
                });
                stream.end(file.buffer);
            });
        }
        // registro en la DB
        await sequelize.query("CALL spu_create_file(:name, :ext, :size, :cat, :loc, :path, :uid)", {
            replacements: {
                name: file.originalname,
                ext: extension,
                size: file.size,
                cat: category,
                loc: location,
                path: finalPath,
                uid: uid_user,
            },
            type: QueryTypes.RAW,
        });
        res.status(201).json({
            success: true,
            message: `file uploaded successfully to ${location}`,
            location,
            data: { name: file.originalname, path: finalPath },
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            message: "upload failed",
            error: error.message,
        });
    }
};
export const removeFile = async (req, res) => {
    try {
        const { fileName, location, uid_user } = req.body;
        if (!fileName || !location || !uid_user) {
            return res.status(400).json({ message: "missing required data" });
        }
        if (location === "local") {
            const bridgeBaseUrl = process.env.BRIDGE_URL?.replace("/upload-bridge", "");
            await axios.delete(`${bridgeBaseUrl}/sync-delete`, {
                data: { fileName, uid_user },
                headers: {
                    "bypass-tunnel-reminder": "true",
                    "cf-skip-browser-warning": "true",
                },
            });
        }
        else if (location === "cloud") {
            const file = bucket.file(`uploads/${uid_user}/${fileName}`);
            await file.delete();
        }
        const rawResult = await sequelize.query("CALL sp_delete_file_by_name(:name, :uid)", {
            replacements: { name: fileName, uid: uid_user },
            type: QueryTypes.RAW,
        });
        const affectedRows = rawResult && rawResult[0] ? rawResult[0].affectedRows : 0;
        if (affectedRows > 0) {
            res.status(200).json({
                success: true,
                message: "file deleted from storage and database",
            });
        }
        else {
            res.status(200).json({
                success: true,
                message: "file deleted from storage, but no database record found",
            });
        }
    }
    catch (error) {
        console.error("❌ Error in removeFile:", error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            message: "failed to delete file",
            error: error.response?.data?.message || error.message,
        });
    }
};
// --- sync de registros en DB ---
export const syncAdd = async (req, res) => {
    try {
        const { fileName, filePath, uid_user } = req.body;
        if (!fileName || !filePath)
            return res.status(400).json({ message: "missing data" });
        const resDb = await sequelize.query("CALL sp_auto_register_file(:name, :path, :uid)", {
            replacements: {
                name: fileName,
                path: filePath,
                uid: uid_user || "SIN_USUARIO",
            },
            type: QueryTypes.RAW,
        });
        const data = Array.isArray(resDb) ? resDb[0] : resDb;
        const added = data?.status === 1;
        if (added) {
            res.status(201).json({
                success: true,
                message: `file ${fileName} registered successfully`,
            });
        }
        else {
            res
                .status(200)
                .json({ success: true, message: "file already registered" });
        }
    }
    catch (error) {
        res.status(500).json({
            success: false,
            message: "sync add error",
            error: error.message,
        });
    }
};
export const syncDelete = async (req, res) => {
    try {
        const { fileName, uid_user } = req.body;
        if (!fileName || !uid_user)
            return res.status(400).json({ message: "missing data" });
        const resDb = await sequelize.query("CALL sp_delete_file_by_name(:name, :uid)", {
            replacements: { name: fileName, uid: uid_user },
            type: QueryTypes.RAW,
        });
        const data = Array.isArray(resDb) ? resDb[0] : resDb;
        const success = data?.affectedRows > 0;
        if (success) {
            res.status(200).json({
                success: true,
                message: `file ${fileName} removed from database`,
            });
        }
        else {
            res
                .status(404)
                .json({ success: false, message: "record not found for deletion" });
        }
    }
    catch (error) {
        res.status(500).json({
            success: false,
            message: "sync delete error",
            error: error.message,
        });
    }
};
