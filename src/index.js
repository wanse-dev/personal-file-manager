import express from "express";
import cors from "cors";
import "dotenv/config";
import routes from "./routes/index.js";
import { connectDB } from "./database.js";
const app = express();
const PORT = process.env.PORT || 5000;
// --- middlewares ---
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
connectDB();
// --- health check ---
app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "hibrid-file-manager-api",
    });
});
app.use("/api", routes);
// --- error handler ---
app.use((err, req, res, next) => {
    console.error("error detectado:", err.stack);
    res.status(500).json({
        message: "internal server error",
        error: process.env.NODE_ENV === "development" ? err.message : {},
    });
});
// --- server startup ---
app.listen(PORT, () => {
    console.log(`server ready at port: ${PORT}`);
    console.log(`bridge status: ${process.env.BRIDGE_URL ? "configured" : "not found"}`);
});
