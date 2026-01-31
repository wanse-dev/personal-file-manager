import type { Request, Response } from "express";
import { sequelize } from "../../database.js";
import { bucket } from "../../config/firebase.js";
import { QueryTypes } from "sequelize";
import axios from "axios";
import FormData from "form-data";

// --- helpers ---

const getBridgeUrl = () =>
  process.env.BRIDGE_URL?.replace("/upload-bridge", "") || "";

const getHeaders = (form?: FormData) => ({
  ...(form ? form.getHeaders() : {}),
  "bypass-tunnel-reminder": "true", // para Ngrok (por las dudas)
  "cf-skip-browser-warning": "true", // para Cloudflare
  "User-Agent": "Mozilla/5.0",      // engaña a LocalTunnel para que crea que es un navegador real
});

// --- upload y remove físicos ---

export const uploadFile = async (req: Request, res: Response) => {
  try {
    const file = req.file as Express.Multer.File;
    let { location, uid_user } = req.body;

    if (!file || !location || !uid_user)
      return res.status(400).json({ message: "missing data" });

    // revisa si el archivo ya existe para el usuario
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

    // revisa si el bridge local esta activo
    if (location === "local") {
      try {
        await axios.get(`${getBridgeUrl()}/ping`, { timeout: 2000 });
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

    // upload del archivo fisico
    if (location === "local") {
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      const { data } = await axios.post(
        `${process.env.BRIDGE_URL}/upload-bridge`,
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

    // registro en la DB
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
      const bridgeBaseUrl = process.env.BRIDGE_URL?.replace(
        "/upload-bridge",
        "",
      );

      await axios.delete(`${bridgeBaseUrl}/sync-delete`, {
        data: { fileName, uid_user },
        headers: {
          "bypass-tunnel-reminder": "true",
          "cf-skip-browser-warning": "true",
        },
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

    if (affectedRows > 0) {
      res.status(200).json({
        success: true,
        message: "file deleted from storage and database",
      });
    } else {
      res.status(200).json({
        success: true,
        message: "file deleted from storage, but no database record found",
      });
    }
  } catch (error: any) {
    console.error(
      "❌ Error in removeFile:",
      error.response?.data || error.message,
    );
    res.status(error.response?.status || 500).json({
      success: false,
      message: "failed to delete file",
      error: error.response?.data?.message || error.message,
    });
  }
};

// --- sync de registros en DB ---

export const syncAdd = async (req: Request, res: Response) => {
  try {
    const { fileName, filePath, uid_user } = req.body;
    if (!fileName || !filePath)
      return res.status(400).json({ message: "missing data" });

    const resDb: any = await sequelize.query(
      "CALL sp_auto_register_file(:name, :path, :uid)",
      {
        replacements: {
          name: fileName,
          path: filePath,
          uid: uid_user || "SIN_USUARIO",
        },
        type: QueryTypes.RAW,
      },
    );

    const data = Array.isArray(resDb) ? resDb[0] : resDb;
    const added = data?.status === 1;

    if (added) {
      res.status(201).json({
        success: true,
        message: `file ${fileName} registered successfully`,
      });
    } else {
      res
        .status(200)
        .json({ success: true, message: "file already registered" });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "sync add error",
      error: error.message,
    });
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
    const success = data?.affectedRows > 0;

    if (success) {
      res.status(200).json({
        success: true,
        message: `file ${fileName} removed from database`,
      });
    } else {
      res
        .status(404)
        .json({ success: false, message: "record not found for deletion" });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "sync delete error",
      error: error.message,
    });
  }
};

// -- descarga y visualización de archivos --

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

      try {
        // pregunta al bridge por el tamaño del archivo
        const infoRes = await axios.get(
          `${bridgeBaseUrl}/api/bridge/info/${fileName}`,
          {
            headers: getHeaders(),
          },
        );

        const fileSize = infoRes.data.size;
        const limit = 50 * 1024 * 1024; // 50 MB en bytes

        if (fileSize > limit) {
          // si es pesado, entonces redirección 302 a Ngrok
          console.log(`redirecting large file (${fileName}) to Bridge.`);
          return res.redirect(
            `${bridgeBaseUrl}/api/bridge/download/${fileName}`,
          );
        } else {
          // si es liviano, entonces stream a través de Railway
          console.log(`Delivering light file (${fileName}) through Railway.`);

          const response = await axios({
            method: "get",
            url: `${bridgeBaseUrl}/api/bridge/download/${fileName}`,
            responseType: "stream",
            headers: getHeaders(),
          });

          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`,
          );
          res.setHeader(
            "Content-Type",
            response.headers["content-type"] || "application/octet-stream",
          );

          return response.data.pipe(res);
        }
      } catch (err: any) {
        console.error("bridge error:", err.message);
        return res.status(404).json({
          message: "File not found on local storage or bridge offline",
        });
      }
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

    // llamada al spu que me ordena automáticamente por orden de creación descendente
    const filesInDb: any = await sequelize.query(
      "CALL spu_list_user_files(:uid, :limit, :offset)",
      {
        replacements: {
          uid: uid_user,
          limit: limit,
          offset: offset,
        },
        type: QueryTypes.RAW,
      },
    );

    const rows = Array.isArray(filesInDb) ? filesInDb : [];

    if (rows.length === 0) {
      return res.json({ page, total: 0, data: [] });
    }

    // se filtran los que están en el disco local para pedirle info al bridge
    const localFileNames = rows
      .filter((f: any) => f.location === "local")
      .map((f: any) => f.original_name);

    let localDetails: any[] = [];
    if (localFileNames.length > 0) {
      try {
        const bridgeRes = await axios.post(
          `${getBridgeUrl()}/api/bridge/batch-info`,
          {
            files: localFileNames,
          },
          { headers: getHeaders() },
        );
        localDetails = bridgeRes.data;
      } catch (err) {
        console.error("⚠️ bridge offline or batch-info error.");
        // si el bridge falla, sigue el flujo pero con detalles vacios
      }
    }

    // se mezcla la info de la DB con la del disco físico
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
        // si es local, se usa el size del disco. si es cloud, debería usarse el de la DB.
        size: details?.size || 0,
        isAvailable:
          dbFile.location === "local" ? !!details && !details.error : true,
      };
    });

    res.json({
      success: true,
      page,
      count: finalData.length,
      data: finalData,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};
