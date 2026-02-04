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

    const newFolderId = result.id_folder;

    // se reconstruye el PATH
    let fullPathParts: string[] = [];
    let currentId = newFolderId;
    let foundRoot = false;

    while (!foundRoot) {
      const [folder]: any = await sequelize.query(
        "SELECT name, parent_id FROM folders WHERE id_folder = :id AND uid_user = :uid LIMIT 1",
        {
          replacements: { id: currentId, uid: uid_user },
          type: QueryTypes.SELECT,
        },
      );

      if (folder) {
        fullPathParts.unshift(folder.name);
        if (folder.parent_id) {
          currentId = folder.parent_id;
        } else {
          foundRoot = true;
        }
      } else {
        foundRoot = true;
      }
    }

    const fullPathForBridge = fullPathParts.join("/");

    try {
      await axios.post(
        `${getBridgeUrl()}/api/bridge/create-folder`,
        { folder_name: fullPathForBridge },
        { headers: getHeaders(), timeout: 4000 },
      );
    } catch (e: any) {
      console.error("Bridge Sync Error:", e.message);
    }

    res.status(201).json({
      success: true,
      id_folder: newFolderId,
      path: fullPathForBridge,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const removeFolder = async (req: Request, res: Response) => {
  try {
    const { id_folder, uid_user } = req.body;
    if (!id_folder || !uid_user)
      return res.status(400).json({ message: "missing data" });

    // se reconstruye el PATH
    let fullPathParts: string[] = [];
    let currentId = id_folder;
    let foundRoot = false;

    while (!foundRoot) {
      const [folder]: any = await sequelize.query(
        "SELECT name, parent_id FROM folders WHERE id_folder = :id AND uid_user = :uid LIMIT 1",
        {
          replacements: { id: currentId, uid: uid_user },
          type: QueryTypes.SELECT,
        },
      );

      if (folder) {
        fullPathParts.unshift(folder.name);
        if (folder.parent_id) {
          currentId = folder.parent_id;
        } else {
          foundRoot = true;
        }
      } else {
        break;
      }
    }

    const fullPathToDelete = fullPathParts.join("/");

    if (fullPathParts.length === 0) {
      return res.status(404).json({ message: "Folder not found in DB" });
    }

    try {
      await axios.delete(`${getBridgeUrl()}/sync-delete`, {
        data: { fileName: fullPathToDelete, uid_user },
        headers: getHeaders(),
        timeout: 5000,
      });
    } catch (bridgeError: any) {
      console.error("Fallo el borrado físico:", bridgeError.message);
    }

    await sequelize.query(
      "DELETE FROM folders WHERE id_folder = :id AND uid_user = :uid",
      { replacements: { id: id_folder, uid: uid_user }, type: QueryTypes.RAW },
    );

    res.status(200).json({ success: true, path_deleted: fullPathToDelete });
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

    const category = file.mimetype.startsWith("image/")
      ? "image"
      : file.mimetype.startsWith("video/")
        ? "video"
        : "binary";

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
    }

    await sequelize.query(
      "CALL spu_create_file(:name, :ext, :size, :cat, :loc, :folder, :uid, :url)",
      {
        replacements: {
          name: file.originalname,
          ext: file.originalname.split(".").pop(),
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
      data: { name: file.originalname, path: finalPath },
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
    }

    await sequelize.query("CALL spu_delete_file(:id, :uid)", {
      replacements: { id: id_file, uid: uid_user },
      type: QueryTypes.RAW,
    });

    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// --- sincronización automática ---

export const syncFolder = async (req: Request, res: Response) => {
  try {
    const { name, parent_name, uid_user } = req.body;
    if (!name || !uid_user)
      return res.status(400).json({ message: "missing data" });

    let parentId = null;
    if (parent_name) {
      const parts = parent_name.split("/");
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

    const existing: any = await sequelize.query(
      "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :parent OR (parent_id IS NULL AND :parent IS NULL)) LIMIT 1",
      {
        replacements: { name, uid: uid_user, parent: parentId },
        type: QueryTypes.SELECT,
      },
    );

    if (existing.length > 0) return res.status(200).json({ success: true });

    await sequelize.query("CALL spu_create_folder(:name, :parent, :uid)", {
      replacements: { name, parent: parentId, uid: uid_user },
      type: QueryTypes.RAW,
    });

    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const syncAdd = async (req: Request, res: Response) => {
  try {
    const { fileName, extension, size, category, uid_user, folder_name } =
      req.body;
    if (!fileName || !uid_user)
      return res.status(400).json({ message: "missing data" });

    let folderId = null;
    if (folder_name) {
      const parts = folder_name.split("/");
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

export const syncRemove = async (req: Request, res: Response) => {
  try {
    const { fileName, uid_user, folder_name } = req.body;

    if (!fileName || !uid_user)
      return res
        .status(200)
        .json({ success: false, message: "No file data received" });

    let folderId = null;

    if (folder_name) {
      const parts = folder_name.split("/");
      let currentParentId = null;

      for (const part of parts) {
        const [folder]: any = await sequelize.query(
          "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :pId OR (parent_id IS NULL AND :pId IS NULL)) LIMIT 1",
          {
            replacements: { name: part, uid: uid_user, pId: currentParentId },
            type: QueryTypes.SELECT,
          },
        );

        if (folder) {
          currentParentId = folder.id_folder;
        } else {
          console.log(
            `[SYNC-FILE] Ignore: Path ${folder_name} no longer exists.`,
          );
          return res
            .status(200)
            .json({ success: true, message: "Ignored by cascade" });
        }
      }
      folderId = currentParentId;
    }

    await sequelize.query(
      "DELETE FROM files WHERE original_name = :name AND uid_user = :uid AND (id_folder = :folder OR (id_folder IS NULL AND :folder IS NULL))",
      {
        replacements: { name: fileName, uid: uid_user, folder: folderId },
        type: QueryTypes.RAW,
      },
    );

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("Error in syncRemove:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const removeFolderSync = async (req: Request, res: Response) => {
  try {
    const { name, uid_user, parent_name } = req.body;

    if (!name || !uid_user) {
      return res.status(200).json({ success: false, message: "Missing data" });
    }

    let parentId = null;

    if (parent_name) {
      const parts = parent_name.split("/");
      let currentParentId = null;

      for (const part of parts) {
        const [folder]: any = await sequelize.query(
          "SELECT id_folder FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :pId OR (parent_id IS NULL AND :pId IS NULL)) LIMIT 1",
          {
            replacements: { name: part, uid: uid_user, pId: currentParentId },
            type: QueryTypes.SELECT,
          },
        );

        if (folder) {
          currentParentId = folder.id_folder;
        } else {
          console.log(
            `[SYNC] Ignore: Path ${parent_name} already removed from DB.`,
          );
          return res.status(200).json({
            success: true,
            message: "Ignored: Ancestor already deleted by cascade",
          });
        }
      }
      parentId = currentParentId;
    }

    await sequelize.query(
      "DELETE FROM folders WHERE name = :name AND uid_user = :uid AND (parent_id = :parent OR (parent_id IS NULL AND :parent IS NULL))",
      {
        replacements: { name, uid: uid_user, parent: parentId },
        type: QueryTypes.RAW,
      },
    );

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("Error in removeFolderSync:", error.message);
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
      { replacements: { uid: uid_user }, type: QueryTypes.RAW },
    );
    res.json({ success: true, stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const downloadFile = async (req: Request, res: Response) => {
  try {
    const { fileName, location } = req.query;
    if (!fileName || !location)
      return res.status(400).json({ message: "missing data" });

    if (location === "local") {
      return res.redirect(`${getBridgeUrl()}/api/bridge/download/${fileName}`);
    }
    res
      .status(400)
      .json({ message: "cloud download not implemented in this snippet" });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};
