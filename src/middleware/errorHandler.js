function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err);

  if (err.name === "ZodError") {
    return res.status(400).json({ error: "Validation failed", details: err.issues });
  }

  if (err.code === "P2002") {
    // Prisma unique constraint violation
    return res.status(409).json({ error: `Duplicate value for field: ${err.meta?.target}` });
  }

  if (err.code === "P2025") {
    // Prisma record not found
    return res.status(404).json({ error: "Record not found" });
  }

  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
}

module.exports = errorHandler;
