import express from "express";
import fileRoutes from "./file/index.js";

const router = express.Router();

router.use("/file", fileRoutes);

export default router;