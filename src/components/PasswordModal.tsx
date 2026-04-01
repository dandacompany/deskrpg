"use client";
import { useState, useRef, useEffect } from "react";
import { useT } from "@/lib/i18n";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { Input } from "./ui/Input";

interface PasswordModalProps {
  channelName: string;
  onSubmit: (password: string) => Promise<string | null>;
  onClose: () => void;
}

export default function PasswordModal({ channelName, onSubmit, onClose }: PasswordModalProps) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async () => {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    const nextError = await onSubmit(password);
    if (nextError) {
      setError(nextError);
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t("password.title")} size="sm">
      <Modal.Body>
        <p className="text-text-muted text-body mb-4">{channelName}</p>
        <Input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isComposing) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("password.placeholder")}
          error={error}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!password.trim()}
          loading={submitting}
        >
          {t("common.join")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
