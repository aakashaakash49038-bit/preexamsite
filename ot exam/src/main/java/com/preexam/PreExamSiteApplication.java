package com.preexam;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

public final class PreExamSiteApplication {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path DATA_FILE = Path.of(System.getProperty("preexam.data", "data/exam.json"));
    private static final Path RESULTS_FILE = Path.of(System.getProperty("preexam.results", "data/results.json"));
    private static final String ADMIN_PASSWORD = System.getenv().getOrDefault("PREEXAM_ADMIN_PASSWORD", "admin123");
    private static final Map<String, Attempt> ATTEMPTS = new ConcurrentHashMap<>();
    private static ArrayNode results;
    private static ObjectNode exam;

    private record Attempt(ObjectNode snapshot, long expiresAt) { }

    private PreExamSiteApplication() { }

    public static void main(String[] args) throws IOException {
        loadExam();
        loadResults();
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/api/", PreExamSiteApplication::handleApi);
        server.createContext("/", PreExamSiteApplication::handleStatic);
        server.setExecutor(Executors.newFixedThreadPool(Math.max(4, Runtime.getRuntime().availableProcessors())));
        server.start();
        System.out.println("Pre Exam Site is running at http://localhost:" + port);
        if (!System.getenv().containsKey("PREEXAM_ADMIN_PASSWORD")) {
            System.out.println("Using the development admin password. Set PREEXAM_ADMIN_PASSWORD before deployment.");
        }
    }

    private static synchronized void loadExam() throws IOException {
        if (Files.exists(DATA_FILE)) {
            exam = (ObjectNode) JSON.readTree(DATA_FILE.toFile());
        } else {
            try (InputStream input = PreExamSiteApplication.class.getResourceAsStream("/exam.json")) {
                if (input == null) throw new IOException("Missing initial exam configuration.");
                exam = (ObjectNode) JSON.readTree(input);
            }
            saveExam(exam);
        }
        validateExam(exam);
    }

    private static synchronized void loadResults() throws IOException {
        if (Files.exists(RESULTS_FILE)) {
            JsonNode stored = JSON.readTree(RESULTS_FILE.toFile());
            if (!stored.isArray()) throw new IOException("Stored exam results must be a JSON array.");
            results = (ArrayNode) stored;
        } else {
            results = JSON.createArrayNode();
        }
    }

    private static synchronized void saveExam(ObjectNode value) throws IOException {
        Path destination = DATA_FILE.toAbsolutePath();
        Path parent = destination.getParent();
        Files.createDirectories(parent);
        Path temporaryFile = Files.createTempFile(parent, "exam-", ".json.tmp");
        try {
            JSON.writerWithDefaultPrettyPrinter().writeValue(temporaryFile.toFile(), value);
            try {
                Files.move(temporaryFile, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ex) {
                Files.move(temporaryFile, destination, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporaryFile);
        }
    }

    private static void handleApi(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            if ("GET".equals(method) && "/api/exam".equals(path)) {
                sendJson(exchange, 200, publicExam());
            } else if ("GET".equals(method) && "/api/admin/results".equals(path)) {
                if (!requireAdmin(exchange)) return;
                synchronized (PreExamSiteApplication.class) { sendJson(exchange, 200, results.deepCopy()); }
            } else if ("GET".equals(method) && "/api/admin".equals(path)) {
                if (!requireAdmin(exchange)) return;
                synchronized (PreExamSiteApplication.class) { sendJson(exchange, 200, exam.deepCopy()); }
            } else if ("PUT".equals(method) && "/api/admin".equals(path)) {
                if (!requireAdmin(exchange)) return;
                JsonNode parsed = JSON.readTree(readBody(exchange));
                if (!(parsed instanceof ObjectNode updated)) {
                    throw new IllegalArgumentException("Exam settings must be a JSON object.");
                }
                validateExam(updated);
                synchronized (PreExamSiteApplication.class) {
                    saveExam(updated);
                    exam = updated;
                    sendJson(exchange, 200, object("message", "Exam settings saved."));
                }
            } else if ("POST".equals(method) && "/api/attempts".equals(path)) {
                startAttempt(exchange);
            } else if ("POST".equals(method) && path.matches("/api/attempts/[a-fA-F0-9-]+/submit")) {
                submitAttempt(exchange, path.split("/")[3]);
            } else {
                sendJson(exchange, 404, object("error", "API route not found."));
            }
        } catch (IllegalArgumentException ex) {
            sendJson(exchange, 400, object("error", ex.getMessage()));
        } catch (JsonProcessingException ex) {
            sendJson(exchange, 400, object("error", "Request body must contain valid JSON."));
        } catch (IOException | ClassCastException ex) {
            sendJson(exchange, 500, object("error", "The server could not complete that request."));
        }
    }

    private static void startAttempt(HttpExchange exchange) throws IOException {
        long now = System.currentTimeMillis();
        ATTEMPTS.entrySet().removeIf(entry -> entry.getValue().expiresAt() + 60_000L < now);
        ObjectNode snapshot;
        synchronized (PreExamSiteApplication.class) { snapshot = exam.deepCopy(); }
        int duration = snapshot.path("settings").path("durationMinutes").asInt();
        long expiresAt = System.currentTimeMillis() + duration * 60_000L;
        String id = UUID.randomUUID().toString();
        ATTEMPTS.put(id, new Attempt(snapshot, expiresAt));
        ObjectNode response = object("attemptId", id);
        response.put("expiresAt", expiresAt);
        sendJson(exchange, 201, response);
    }

    private static void submitAttempt(HttpExchange exchange, String attemptId) throws IOException {
        JsonNode payload = JSON.readTree(readBody(exchange));
        if (payload == null || !payload.isObject() || !payload.path("answers").isObject()) {
            throw new IllegalArgumentException("Submission must contain an answers object.");
        }
        Attempt attempt = ATTEMPTS.get(attemptId);
        if (attempt == null) {
            sendJson(exchange, 404, object("error", "This exam attempt is missing or has already been submitted."));
            return;
        }
        if (System.currentTimeMillis() > attempt.expiresAt() + 5_000L) {
            ATTEMPTS.remove(attemptId, attempt);
            sendJson(exchange, 410, object("error", "Time is up. This attempt has expired."));
            return;
        }
        JsonNode answers = payload.path("answers");
        JsonNode questions = attempt.snapshot().path("questions");
        for (JsonNode question : questions) {
            JsonNode selected = answers.get(question.path("id").asText());
            if (selected != null && (!selected.isIntegralNumber()
                    || selected.asInt() < 0
                    || selected.asInt() >= question.path("options").size())) {
                throw new IllegalArgumentException("An answer choice is invalid.");
            }
        }
        JsonNode settings = attempt.snapshot().path("settings");
        double correctMarks = settings.path("correctMarks").asDouble();
        double negativeMarks = settings.path("negativeMarks").asDouble();
        int correct = 0;
        int wrong = 0;
        int skipped = 0;
        double score = 0;
        ArrayNode review = JSON.createArrayNode();
        for (JsonNode question : questions) {
            String id = question.path("id").asText();
            JsonNode selected = answers.path(id);
            int selectedIndex = selected.isInt() ? selected.asInt() : -1;
            int correctIndex = question.path("correctIndex").asInt(-1);
            String status;
            if (selectedIndex < 0) {
                skipped++;
                status = "skipped";
            } else if (selectedIndex == correctIndex) {
                correct++;
                score += correctMarks;
                status = "correct";
            } else {
                wrong++;
                score -= negativeMarks;
                status = "wrong";
            }
            ObjectNode item = (ObjectNode) question.deepCopy();
            item.put("selectedIndex", selectedIndex);
            item.put("status", status);
            review.add(item);
        }
        ObjectNode result = object("correct", correct, "wrong", wrong, "skipped", skipped);
        result.put("score", score);
        result.put("totalQuestions", questions.size());
        result.put("maxScore", questions.size() * correctMarks);
        result.set("review", review);
        ObjectNode storedResult = result.deepCopy();
        storedResult.put("attemptId", attemptId);
        storedResult.put("completedAt", System.currentTimeMillis());
        storedResult.put("examTitle", settings.path("title").asText());
        synchronized (PreExamSiteApplication.class) {
            if (ATTEMPTS.get(attemptId) != attempt) {
                sendJson(exchange, 404, object("error", "This exam attempt has already been submitted."));
                return;
            }
            saveResult(storedResult);
            ATTEMPTS.remove(attemptId, attempt);
        }
        sendJson(exchange, 200, result);
    }

    private static synchronized void saveResult(ObjectNode result) throws IOException {
        ArrayNode updated = results.deepCopy();
        updated.add(result);
        Path destination = RESULTS_FILE.toAbsolutePath();
        Path parent = destination.getParent();
        Files.createDirectories(parent);
        Path temporaryFile = Files.createTempFile(parent, "results-", ".json.tmp");
        try {
            JSON.writerWithDefaultPrettyPrinter().writeValue(temporaryFile.toFile(), updated);
            try {
                Files.move(temporaryFile, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ex) {
                Files.move(temporaryFile, destination, StandardCopyOption.REPLACE_EXISTING);
            }
            results = updated;
        } finally {
            Files.deleteIfExists(temporaryFile);
        }
    }

    private static synchronized ObjectNode publicExam() {
        ObjectNode copy = exam.deepCopy();
        for (JsonNode item : copy.path("questions")) ((ObjectNode) item).remove("correctIndex");
        return copy;
    }

    private static void validateExam(JsonNode value) {
        if (value == null || !value.isObject()) throw new IllegalArgumentException("Exam settings must be a JSON object.");
        JsonNode settings = value.path("settings");
        if (!settings.isObject()) throw new IllegalArgumentException("Exam settings are missing.");
        JsonNode durationNode = settings.path("durationMinutes");
        JsonNode correctMarksNode = settings.path("correctMarks");
        JsonNode negativeMarksNode = settings.path("negativeMarks");
        if (!durationNode.isIntegralNumber() || !correctMarksNode.isNumber() || !negativeMarksNode.isNumber()) {
            throw new IllegalArgumentException("Duration and marks must be valid numbers.");
        }
        int duration = durationNode.asInt(-1);
        double correctMarks = correctMarksNode.asDouble(-1);
        double negativeMarks = negativeMarksNode.asDouble(-1);
        JsonNode questions = value.path("questions");
        if (!settings.path("title").isTextual() || settings.path("title").asText().isBlank())
            throw new IllegalArgumentException("Enter an exam title.");
        if (settings.path("title").asText().length() > 80) throw new IllegalArgumentException("Exam title must be 80 characters or less.");
        if (duration < 1 || duration > 300) throw new IllegalArgumentException("Duration must be between 1 and 300 minutes.");
        if (!Double.isFinite(correctMarks) || !Double.isFinite(negativeMarks)
                || correctMarks < 0 || negativeMarks < 0) throw new IllegalArgumentException("Marks must be valid non-negative numbers.");
        if (correctMarks > 1000 || negativeMarks > 1000) throw new IllegalArgumentException("Each mark value must be 1000 or less.");
        if (!questions.isArray() || questions.isEmpty() || questions.size() > 200)
            throw new IllegalArgumentException("An exam must have between 1 and 200 questions.");
        java.util.HashSet<String> ids = new java.util.HashSet<>();
        for (JsonNode question : questions) {
            String id = question.path("id").asText();
            JsonNode options = question.path("options");
            int answer = question.path("correctIndex").asInt(-1);
            if (id.isBlank() || !ids.add(id)) throw new IllegalArgumentException("Question IDs must be unique.");
                if (!question.path("text").isTextual() || question.path("text").asText().isBlank()
                    || question.path("text").asText().length() > 500)
                throw new IllegalArgumentException("Every question needs question text.");
            if (!options.isArray() || options.size() < 2) throw new IllegalArgumentException("Every question needs at least two answer choices.");
            if (options.size() > 8) throw new IllegalArgumentException("Each question can have at most eight answer choices.");
            for (JsonNode option : options) {
                if (!option.isTextual() || option.asText().isBlank()) throw new IllegalArgumentException("Fill in every answer choice.");
            }
            JsonNode image = question.path("image");
            if (!image.isMissingNode() && !image.isNull() && (!image.isTextual()
                    || image.asText().length() > 850_000
                    || !image.asText().matches("^data:image/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$"))) {
                throw new IllegalArgumentException("Question images must be PNG, JPEG, WebP, or GIF files under 600 KB.");
            }
            if (answer < 0 || answer >= options.size()) throw new IllegalArgumentException("Choose a correct answer for every question.");
        }
    }

    private static void handleStatic(HttpExchange exchange) throws IOException {
        if (exchange.getRequestURI().getPath().startsWith("/api/")) {
            sendJson(exchange, 404, object("error", "API route not found."));
            return;
        }
        exchange.getResponseHeaders().set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
        exchange.getResponseHeaders().set("Referrer-Policy", "no-referrer");
        if (!"GET".equals(exchange.getRequestMethod())) {
            sendText(exchange, 405, "Method not allowed.", "text/plain; charset=utf-8");
            return;
        }
        String path = exchange.getRequestURI().getPath();
        if ("/".equals(path)) path = "/index.html";
        if (!path.matches("/(index\\.html|styles\\.css|admin\\.css|app\\.js)")) {
            sendText(exchange, 404, "Not found.", "text/plain; charset=utf-8");
            return;
        }
        try (InputStream input = PreExamSiteApplication.class.getResourceAsStream("/public" + path)) {
            if (input == null) {
                sendText(exchange, 404, "Web files not found. Build the project with Maven first.", "text/plain; charset=utf-8");
                return;
            }
            String type = path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
            byte[] body = input.readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", type);
            exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            exchange.getResponseHeaders().set("Cache-Control", "no-cache");
            exchange.sendResponseHeaders(200, body.length);
            try (var responseBody = exchange.getResponseBody()) {
                responseBody.write(body);
            }
        }
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readNBytes(10_000_001);
        if (bytes.length > 10_000_000) throw new IllegalArgumentException("Request body cannot exceed 10 MB.");
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static boolean requireAdmin(HttpExchange exchange) throws IOException {
        String requestedWith = exchange.getRequestHeaders().getFirst("X-Requested-With");
        if (!"XMLHttpRequest".equals(requestedWith)) {
            sendJson(exchange, 403, object("error", "Admin requests must come from the exam site."));
            return false;
        }
        String supplied = exchange.getRequestHeaders().getFirst("X-Admin-Password");
        byte[] expected = ADMIN_PASSWORD.getBytes(StandardCharsets.UTF_8);
        byte[] actual = (supplied == null ? "" : supplied).getBytes(StandardCharsets.UTF_8);
        if (java.security.MessageDigest.isEqual(expected, actual)) return true;
        sendJson(exchange, 401, object("error", "Admin password is incorrect."));
        return false;
    }

    private static ObjectNode object(Object... values) {
        ObjectNode node = JSON.createObjectNode();
        for (int i = 0; i < values.length; i += 2) {
            Object value = values[i + 1];
            if (value instanceof String text) node.put((String) values[i], text);
            else if (value instanceof Integer number) node.put((String) values[i], number);
            else if (value instanceof Double number) node.put((String) values[i], number);
        }
        return node;
    }

    private static void sendJson(HttpExchange exchange, int status, JsonNode body) throws IOException {
        sendText(exchange, status, JSON.writeValueAsString(body), "application/json; charset=utf-8");
    }

    private static void sendText(HttpExchange exchange, int status, String body, String contentType) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var responseBody = exchange.getResponseBody()) {
            responseBody.write(bytes);
        }
    }
}
