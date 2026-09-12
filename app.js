require("dotenv").config();
require("express-async-errors"); // lets async route handlers throw and hit errorHandler automatically

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const authRoutes = require("./routes/auth.routes");
const publicRoutes = require("./routes/public.routes");
const creatorsRoutes = require("./routes/creators.routes");
const campaignsRoutes = require("./routes/campaigns.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");
const shippingRoutes = require("./routes/shipping.routes");
const contentRoutes = require("./routes/content.routes");
const performanceRoutes = require("./routes/performance.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reportsRoutes = require("./routes/reports.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "crexup-backend" }));

// Public, no-login endpoints (creator registration, campaign confirmation,
// content submission, brand inquiry)
app.use("/api/public", publicRoutes);

// Admin-only (all require Bearer token via requireAdminAuth inside each router)
app.use("/api/auth", authRoutes);
app.use("/api/creators", creatorsRoutes);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/content", contentRoutes);
app.use("/api/performance", performanceRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportsRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

module.exports = app;
