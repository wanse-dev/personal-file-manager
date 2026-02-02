import type { Request, Response } from "express";
import { sequelize } from "../../database.js";
import { bucket } from "../../config/firebase.js";
import { QueryTypes } from "sequelize";
import axios from "axios";
import FormData from "form-data";

// --- helpers ---

const getBridgeUrl = () => {
  let url = process.env.BRIDGE_URL || "";
  // Limpiamos la URL por si viene con el endpoint de upload o barras al final
  return url.replace("/upload-bridge", "").replace(/\/+$/, "");
};

const getHeaders = (form?: FormData) => ({
  ...(form ? form.getHeaders() : {}),
  "bypass-tunnel-reminder": "true",
  "cf-skip-browser-warning": "true",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "*/*",
  Connection: "keep-alive",
});

// --- upload y remove físicos ---

export const uploadFile = async (req: Request, res: Response) => {
  try {
    const file = req.file as Express.Multer.File;
    let { location, uid_user } = req.body;

    if (!file || !location || !uid_user)
      return res.status(400).json({ message: "missing data" });

    const existingFile: any = await sequelize.query(
      "SELECT id_file FROM files WHERE original_name = :name AND uid_user = :uid LIMIT 1",
      {
        replacements: { name: file.originalname, uid: uid_user },
        type: QueryTypes.SELECT,
      },
    );

    if (existingFile.length > 0) {
      return res.status(409).json({
        success: false,
        message: "file already exists",
      });
    }

    if (location === "local") {
      try {
        await axios.get(`${getBridgeUrl()}/ping`, {
          timeout: 2000,
          headers: getHeaders(),
        });
      } catch (err) {
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

    if (location === "local") {
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      const { data } = await axios.post(
        `${getBridgeUrl()}/upload-bridge`,
        form,
        {
          headers: getHeaders(form),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );
      finalPath = data.path;
    } else {
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

    await sequelize.query(
      "CALL spu_create_file(:name, :ext, :size, :cat, :loc, :path, :uid)",
      {
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
      },
    );

    res.status(201).json({
      success: true,
      message: `file uploaded successfully to ${location}`,
      location,
      data: { name: file.originalname, path: finalPath },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "upload failed",
      error: error.message,
    });
  }
};

export const removeFile = async (req: Request, res: Response) => {
  try {
    const { fileName, location, uid_user } = req.body;

    if (!fileName || !location || !uid_user) {
      return res.status(400).json({ message: "missing required data" });
    }

    if (location === "local") {
      const bridgeBaseUrl = getBridgeUrl();

      await axios.delete(`${bridgeBaseUrl}/sync-delete`, {
        data: { fileName, uid_user },
        headers: getHeaders(),
      });
    } else if (location === "cloud") {
      const file = bucket.file(`uploads/${uid_user}/${fileName}`);
      await file.delete();
    }

    const rawResult: any = await sequelize.query(
      "CALL sp_delete_file_by_name(:name, :uid)",
      {
        replacements: { name: fileName, uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    const affectedRows =
      rawResult && rawResult[0] ? rawResult[0].affectedRows : 0;

    res.status(200).json({
      success: true,
      message:
        affectedRows > 0 ? "file deleted" : "file deleted from storage only",
    });
  } catch (error: any) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "failed to delete file",
      error: error.message,
    });
  }
};

export const syncAdd = async (req: Request, res: Response) => {
  try {
    const { fileName, extension, size, category, uid_user } = req.body;
    if (!fileName || !uid_user)
      return res.status(400).json({ message: "missing data" });

    const resDb: any = await sequelize.query(
      "CALL sp_auto_register_file(:name, :ext, :size, :cat, :path, :uid)",
      {
        replacements: {
          name: fileName,
          ext: extension || "bin",
          size: size || 0,
          cat: category || "binary",
          path: "local",
          uid: uid_user,
        },
        type: QueryTypes.RAW,
      },
    );

    const data = Array.isArray(resDb) ? resDb[0] : resDb;
    const added = data?.status === 1;

    res.status(added ? 201 : 200).json({
      success: true,
      message: added ? "File registered" : "File already exists",
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const syncDelete = async (req: Request, res: Response) => {
  try {
    const { fileName, uid_user } = req.body;
    if (!fileName || !uid_user)
      return res.status(400).json({ message: "missing data" });

    const resDb: any = await sequelize.query(
      "CALL sp_delete_file_by_name(:name, :uid)",
      {
        replacements: { name: fileName, uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    const data = Array.isArray(resDb) ? resDb[0] : resDb;
    res.status(data?.affectedRows > 0 ? 200 : 404).json({
      success: data?.affectedRows > 0,
      message: data?.affectedRows > 0 ? "removed" : "not found",
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// -- descarga y visualización --

export const downloadFile = async (req: Request, res: Response) => {
  try {
    const { fileName, location } = req.query;

    if (!fileName || !location) {
      return res.status(400).json({ message: "missing fileName or location" });
    }

    if (location === "cloud") {
      const { uid_user } = req.query;
      const file = bucket.file(`uploads/${uid_user}/${fileName}`);
      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });
      return res.redirect(url);
    }

    if (location === "local") {
      const bridgeBaseUrl = getBridgeUrl();
      const directCloudflareUrl = `${bridgeBaseUrl}/api/bridge/download/${fileName}`;

      console.log(`📡 Redirecting to Cloudflare Tunnel: ${fileName}`);
      return res.redirect(directCloudflareUrl);
    }

    res.status(400).json({ message: "invalid location" });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getFilesSortedByMostRecent = async (
  req: Request,
  res: Response,
) => {
  try {
    const { uid_user } = req.query;
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    if (!uid_user)
      return res.status(400).json({ message: "uid_user is required" });

    const filesInDb: any = await sequelize.query(
      "CALL spu_list_user_files(:uid, :limit, :offset)",
      {
        replacements: { uid: uid_user, limit, offset },
        type: QueryTypes.RAW,
      },
    );

    const rows = Array.isArray(filesInDb) ? filesInDb : [];
    if (rows.length === 0) return res.json({ page, total: 0, data: [] });

    const localFileNames = rows
      .filter((f: any) => f.location === "local")
      .map((f: any) => f.original_name);

    let localDetails: any[] = [];
    if (localFileNames.length > 0) {
      try {
        const bridgeRes = await axios.post(
          `${getBridgeUrl()}/api/bridge/batch-info`,
          { files: localFileNames },
          { headers: getHeaders() },
        );
        localDetails = bridgeRes.data;
      } catch (err) {
        console.error("⚠️ Bridge offline.");
      }
    }

    const finalData = rows.map((dbFile: any) => {
      const details = localDetails.find(
        (ld: any) => ld.name === dbFile.original_name,
      );
      return {
        id: dbFile.id_file,
        name: dbFile.original_name,
        extension: dbFile.extension,
        category: dbFile.category,
        location: dbFile.location,
        createdAt: dbFile.created_at,
        size: details?.size || 0,
        isAvailable:
          dbFile.location === "local" ? !!details && !details.error : true,
      };
    });

    res.json({ success: true, page, count: finalData.length, data: finalData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};
