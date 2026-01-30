import { Sequelize } from "sequelize";
import "dotenv/config";
export const sequelize = new Sequelize(process.env.DB_NAME || "", process.env.DB_USER || "", process.env.DB_PASS || "", {
    host: process.env.DB_HOST || "localhost",
    dialect: "mysql",
    logging: false,
});
export const connectDB = async () => {
    try {
        await sequelize.authenticate();
        console.log("Database connected.");
        await sequelize.sync();
    }
    catch (error) {
        console.error("Database couldn't be connected:", error);
        process.exit(1);
    }
};
