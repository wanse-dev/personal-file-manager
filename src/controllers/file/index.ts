import type { Request, Response } from "express";
import { sequelize } from "../../database.js";
import { bucket } from "../../config/firebase.js";
import { QueryTypes } from "sequelize";
import axios from "axios";
import FormData from "form-data";

// --- helpers ---

const getBridgeUrl = () => {
  let url = process.env.BRIDGE_URL || "";
  return url.replace("/upload-bridge", "").replace(/\/+$/, "");
};

const getHeaders = (form?: FormData) => ({
  ...(form ? form.getHeaders() : {}),
  "x-bridge-key": process.env.BRIDGE_API_KEY,
  "bypass-tunnel-reminder": "true",
  "cf-skip-browser-warning": "true",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "*/*",
  Connection: "keep-alive",
});

// --- carpetas ---

export const createFolder = async (req: Request, res: Response) => {
  try {
    const { name, parent_id, uid_user } = req.body;
    if (!name || !uid_user)
      return res.status(400).json({ message: "missing data" });

    const [result]: any = await sequelize.query(
      "CALL spu_create_folder(:name, :parent, :uid)",
      {
        replacements: { name, parent: parent_id || null, uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    try {
      let folderPath = name;

      if (parent_id) {
        const [parent]: any = await sequelize.query(
          "SELECT name FROM folders WHERE id_folder = :id LIMIT 1",
          { replacements: { id: parent_id }, type: QueryTypes.SELECT },
        );
        if (parent) {
          folderPath = `${parent.name}/${name}`;
        }
      }

      await axios.post(
        `${getBridgeUrl()}/api/bridge/create-folder`,
        { folder_name: folderPath },
        {
          headers: getHeaders(),
          timeout: 4000,
        },
      );
    } catch (bridgeError: any) {
      console.error("Bridge folder creation failed:", bridgeError.message);
    }

    res.status(201).json({
      success: true,
      id_folder: result.id_folder,
      message: "Folder created in DB and sync command sent to Bridge",
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const removeFolder = async (req: Request, res: Response) => {
  try {
    const { id_folder, name, uid_user } = req.body;

    if (!id_folder || !name || !uid_user) {
      return res.status(400).json({ message: "missing data" });
    }

    try {
      await axios.delete(`${getBridgeUrl()}/sync-delete`, {
        data: { fileName: name, uid_user },
        headers: getHeaders(),
        timeout: 5000,
      });
    } catch (bridgeError: any) {
      console.error(
        "Fallo el borrado físico en el Bridge:",
        bridgeError.message,
      );
    }

    const [result]: any = await sequelize.query(
      "DELETE FROM folders WHERE id_folder = :id AND uid_user = :uid",
      {
        replacements: { id: id_folder, uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    res.status(200).json({
      success: true,
      message: "Folder deleted from DB and command sent to Bridge",
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// --- upload y remove ---

export const uploadFile = async (req: Request, res: Response) => {
  try {
    const file = req.file as Express.Multer.File;
    let { location, uid_user, id_folder } = req.body;

    if (!file || !location || !uid_user)
      return res.status(400).json({ message: "missing data" });

    const existingFile: any = await sequelize.query(
      "SELECT id_file FROM files WHERE original_name = :name AND uid_user = :uid AND (id_folder = :folder OR (id_folder IS NULL AND :folder IS NULL)) LIMIT 1",
      {
        replacements: {
          name: file.originalname,
          uid: uid_user,
          folder: id_folder || null,
        },
        type: QueryTypes.SELECT,
      },
    );

    if (existingFile.length > 0)
      return res
        .status(409)
        .json({ success: false, message: "file already exists" });

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
        : file.mimetype.includes("pdf") || file.mimetype.includes("word")
          ? "document"
          : file.mimetype.startsWith("text/")
            ? "text"
            : "binary";

    const extension = file.originalname.split(".").pop() || "bin";
    let finalPath = "";
    let cloudUrl = null;

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

      cloudUrl = await new Promise((resolve, reject) => {
        stream.on("error", reject);
        stream.on("finish", async () => {
          await blob.makePublic();
          resolve(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
        });
        stream.end(file.buffer);
      });
    }

    await sequelize.query(
      "CALL spu_create_file(:name, :ext, :size, :cat, :loc, :folder, :uid, :url)",
      {
        replacements: {
          name: file.originalname,
          ext: extension,
          size: file.size,
          cat: category,
          loc: location,
          folder: id_folder || null,
          uid: uid_user,
          url: cloudUrl,
        },
        type: QueryTypes.RAW,
      },
    );

    res.status(201).json({
      success: true,
      location,
      data: { name: file.originalname, path: finalPath || cloudUrl },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const removeFile = async (req: Request, res: Response) => {
  try {
    const { id_file, fileName, location, uid_user } = req.body;
    if (!id_file || !fileName || !location || !uid_user)
      return res.status(400).json({ message: "missing data" });

    if (location === "local") {
      await axios.delete(`${getBridgeUrl()}/sync-delete`, {
        data: { fileName, uid_user },
        headers: getHeaders(),
      });
    } else if (location === "cloud") {
      const file = bucket.file(`uploads/${uid_user}/${fileName}`);
      await file.delete().catch(() => console.log("File not in cloud storage"));
    }

    const [result]: any = await sequelize.query(
      "CALL spu_delete_file(:id, :uid)",
      {
        replacements: { id: id_file, uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    res.status(200).json({ success: result.affectedRows > 0 });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// --- sincronización automática ---

export const syncAdd = async (req: Request, res: Response) => {
  try {
    const {
      fileName,
      extension,
      size,
      category,
      uid_user,
      id_folder,
      folder_name,
    } = req.body;
    if (!fileName || !uid_user)
      return res.status(400).json({ message: "missing data" });

    let folderId = id_folder || null;

    if (!folderId && folder_name) {
      const parts = folder_name.split(/\/|\\/);
      let currentParentId = null;
      for (const part of parts) {
        const folder: any = await sequelize.query(
          "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :parentId OR (parent_id IS NULL AND :parentId IS NULL)) LIMIT 1",
          {
            replacements: {
              name: part,
              uid: uid_user,
              parentId: currentParentId,
            },
            type: QueryTypes.SELECT,
          },
        );
        if (folder.length > 0) currentParentId = folder[0].id_folder;
        else {
          currentParentId = null;
          break;
        }
      }
      folderId = currentParentId;
    }

    await sequelize.query(
      "CALL spu_create_file(:name, :ext, :size, :cat, :loc, :folder, :uid, :url)",
      {
        replacements: {
          name: fileName,
          ext: extension || "bin",
          size: size || 0,
          cat: category || "binary",
          loc: "local",
          folder: folderId,
          uid: uid_user,
          url: null,
        },
        type: QueryTypes.RAW,
      },
    );

    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const syncFolder = async (req: Request, res: Response) => {
  try {
    const { name, parent_name, uid_user } = req.body;
    if (!name || !uid_user)
      return res.status(400).json({ message: "missing data" });

    let parentId = null;
    if (parent_name) {
      const parts = parent_name.split(/\/|\\/);
      let currentParentId = null;
      for (const part of parts) {
        const folder: any = await sequelize.query(
          "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :pId OR (parent_id IS NULL AND :pId IS NULL)) LIMIT 1",
          {
            replacements: { name: part, uid: uid_user, pId: currentParentId },
            type: QueryTypes.SELECT,
          },
        );
        if (folder.length > 0) currentParentId = folder[0].id_folder;
        else {
          currentParentId = null;
          break;
        }
      }
      parentId = currentParentId;
    }

    const existingFolder: any = await sequelize.query(
      "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :parent OR (parent_id IS NULL AND :parent IS NULL)) LIMIT 1",
      {
        replacements: { name, uid: uid_user, parent: parentId },
        type: QueryTypes.SELECT,
      },
    );

    if (existingFolder.length > 0)
      return res.status(200).json({ success: true });

    await sequelize.query("CALL spu_create_folder(:name, :parent, :uid)", {
      replacements: { name, parent: parentId, uid: uid_user },
      type: QueryTypes.RAW,
    });

    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const syncRemove = async (req: Request, res: Response) => {
  try {
    const { fileName, uid_user } = req.body;

    if (!fileName || !uid_user)
      return res
        .status(200)
        .json({ success: false, message: "No file data received" });

    await sequelize.query(
      "DELETE FROM files WHERE original_name = :name AND uid_user = :uid",
      { replacements: { name: fileName, uid: uid_user }, type: QueryTypes.RAW },
    );

    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const removeFolderSync = async (req: Request, res: Response) => {
  try {
    const { name, uid_user } = req.body;

    if (!name || !uid_user)
      return res
        .status(200)
        .json({ success: false, message: "No folder data received" });

    await sequelize.query(
      "DELETE FROM folders WHERE name = :name AND uid_user = :uid",
      { replacements: { name, uid: uid_user }, type: QueryTypes.RAW },
    );

    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// --- lectura y stats ---

export const getContent = async (req: Request, res: Response) => {
  try {
    const { uid_user, id_folder } = req.query;
    if (!uid_user)
      return res.status(400).json({ message: "uid_user required" });

    const results: any = await sequelize.query(
      "CALL spu_list_folder_content(:uid, :folder)",
      {
        replacements: { uid: uid_user, folder: id_folder || null },
        type: QueryTypes.RAW,
      },
    );

    res.json({ success: true, data: Array.isArray(results) ? results : [] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getStorageStats = async (req: Request, res: Response) => {
  try {
    const { uid_user } = req.query;
    const [stats]: any = await sequelize.query(
      "CALL spu_get_user_storage_stats(:uid)",
      {
        replacements: { uid: uid_user },
        type: QueryTypes.RAW,
      },
    );

    res.json({ success: true, stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const downloadFile = async (req: Request, res: Response) => {
  try {
    const { fileName, location, cloud_url } = req.query;
    if (!fileName || !location)
      return res.status(400).json({ message: "missing data" });

    if (location === "cloud" || location === "both") {
      if (cloud_url) return res.redirect(cloud_url as string);

      const { uid_user } = req.query;
      const file = bucket.file(`uploads/${uid_user}/${fileName}`);
      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });
      return res.redirect(url);
    }

    if (location === "local") {
      return res.redirect(`${getBridgeUrl()}/api/bridge/download/${fileName}`);
    }

    res.status(400).json({ message: "invalid location" });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};
