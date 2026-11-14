"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import dialog from "@/components/app/ConfirmDialog.module.css";
import { categoryLabel } from "@/components/app/format";
import { useToast } from "@/components/app/Toast";
import ui from "@/components/app/ui.module.css";
import { setProfileMedia, updateSocial } from "@/lib/storage";
import {
  COVER_PRESETS,
  PROFILE_LIMITS,
  type CoverChoice,
  type Profile,
  type ProfileMedia,
  type ProfileSocial,
} from "@/lib/types";
import { Avatar } from "./Avatar";
import { AVATAR_SIZE, COVER_SIZE, PhotoError, resizePhoto, type PhotoSize } from "./image";
import { PRESET_LABELS, autoCoverSrc, presetSrc } from "./social";
import styles from "./profile.module.css";

interface EditProfileProps {
  profile: Profile;
  social: ProfileSocial;
  media: ProfileMedia;
}

/** "Edit profile" button + Radix Dialog: name, bio, photo and cover. Nothing is saved until Save. */
export function EditProfileDialog(props: EditProfileProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="pill">Edit profile</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialog.overlay} />
        <Dialog.Content className={`${dialog.content} ${styles.editContent}`}>
          <Dialog.Title className={dialog.title}>Edit profile</Dialog.Title>
          <Dialog.Description className={dialog.description}>
            Saved only in this browser. No account needed.
          </Dialog.Description>
          {/* Mounted only while open, so every opening starts from the saved profile. */}
          <EditForm {...props} onDone={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Busy = null | "avatar" | "cover";
type PhotoField = "avatar" | "cover";

function EditForm({ profile, social, media, onDone }: EditProfileProps & { onDone: () => void }) {
  const notify = useToast();
  const id = useId();
  const [name, setName] = useState(social.displayName);
  const [bio, setBio] = useState(social.bio);
  const [avatar, setAvatar] = useState(media.avatar);
  const [coverPhoto, setCoverPhoto] = useState(media.cover);
  const [cover, setCover] = useState<CoverChoice>(social.cover === "photo" && !media.cover ? "auto" : social.cover);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Partial<Record<PhotoField, string>>>({});
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const topInterest = profile.interests[0];
  const options: { value: CoverChoice; label: string; src: string }[] = [
    { value: "auto", label: topInterest ? `Auto: ${categoryLabel(topInterest)}` : "Auto", src: autoCoverSrc(profile) },
    ...COVER_PRESETS.map((preset) => ({ value: preset, label: PRESET_LABELS[preset], src: presetSrc(preset) })),
    ...(coverPhoto ? [{ value: "photo" as const, label: "Your photo", src: coverPhoto }] : []),
  ];

  async function readPhoto(field: PhotoField, event: ChangeEvent<HTMLInputElement>, size: PhotoSize) {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again still fires change
    if (!file) return;
    setBusy(field);
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    try {
      const url = await resizePhoto(file, size);
      if (field === "avatar") {
        setAvatar(url);
      } else {
        setCoverPhoto(url);
        setCover("photo");
      }
    } catch (err) {
      const text = err instanceof PhotoError ? err.message : "We couldn't read that image. Try a JPEG or PNG.";
      setErrors((prev) => ({ ...prev, [field]: text }));
    } finally {
      setBusy(null);
    }
  }

  const removeCoverPhoto = () => {
    setCoverPhoto(undefined);
    if (cover === "photo") setCover("auto");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    updateSocial({ displayName: name, bio, cover: cover === "photo" && !coverPhoto ? "auto" : cover });
    let stored = true;
    if (avatar !== media.avatar || coverPhoto !== media.cover) {
      stored = setProfileMedia({ avatar, cover: coverPhoto });
    }
    onDone();
    if (stored) notify("Profile saved");
    else notify("Profile saved, photos for this visit only", "This browser's storage is full, so the photos weren't kept. Try smaller photos.");
  };

  return (
    <form className={styles.editForm} onSubmit={onSubmit} noValidate>
      <div className={styles.editBody}>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            type="text"
            autoComplete="name"
            placeholder="Your name"
            maxLength={PROFILE_LIMITS.name}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={`${id}-bio`}>Bio</label>
          <textarea
            id={`${id}-bio`}
            rows={3}
            placeholder="What are you saving up for?"
            maxLength={PROFILE_LIMITS.bio}
            value={bio}
            aria-describedby={`${id}-bio-count`}
            onChange={(event) => setBio(event.target.value)}
          />
          <p id={`${id}-bio-count`} className="help">
            {bio.length}/{PROFILE_LIMITS.bio} characters
          </p>
        </div>

        <div className={styles.photoField} role="group" aria-labelledby={`${id}-photo`}>
          <Avatar src={avatar} name={name} alt={avatar ? "Your new profile photo" : ""} className={styles.photoPreview} />
          <div className={styles.photoControls}>
            <p id={`${id}-photo`} className="label">
              Photo
            </p>
            <div className={ui.actions}>
              <button
                type="button"
                className="pill small alt"
                aria-disabled={busy !== null || undefined}
                onClick={() => {
                  if (!busy) avatarInput.current?.click();
                }}
              >
                {busy === "avatar" ? "Resizing…" : avatar ? "Change photo" : "Upload photo"}
              </button>
              {avatar ? (
                <button type="button" className="pill small alt" onClick={() => setAvatar(undefined)}>
                  Remove photo
                </button>
              ) : null}
            </div>
            <p className="help">Any image up to 10 MB, cropped to a square.</p>
            {errors.avatar ? (
              <p className={ui.error} role="alert">
                {errors.avatar}
              </p>
            ) : null}
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              hidden
              data-photo="avatar"
              onChange={(event) => void readPhoto("avatar", event, AVATAR_SIZE)}
            />
          </div>
        </div>

        <fieldset className={styles.coverField}>
          <legend className="label">Cover</legend>
          <div className={styles.coverGrid}>
            {options.map((option) => (
              <label key={option.value} className={styles.coverOption}>
                <input
                  type="radio"
                  name={`${id}-cover`}
                  value={option.value}
                  checked={cover === option.value}
                  onChange={() => setCover(option.value)}
                  className={styles.coverRadio}
                />
                {/* Decorative thumbnail: the text label names the choice. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={option.src} alt="" className={styles.coverThumb} loading="lazy" decoding="async" />
                <span className={styles.coverLabel}>{option.label}</span>
              </label>
            ))}
          </div>
          <div className={ui.actions}>
            <button
              type="button"
              className="pill small alt"
              aria-disabled={busy !== null || undefined}
              onClick={() => {
                if (!busy) coverInput.current?.click();
              }}
            >
              {busy === "cover" ? "Resizing…" : coverPhoto ? "Replace cover photo" : "Upload a cover photo"}
            </button>
            {coverPhoto ? (
              <button type="button" className="pill small alt" onClick={removeCoverPhoto}>
                Remove cover photo
              </button>
            ) : null}
          </div>
          <p className="help">Auto follows your top interest. Photos are cropped to 3:1.</p>
          {errors.cover ? (
            <p className={ui.error} role="alert">
              {errors.cover}
            </p>
          ) : null}
          <input
            ref={coverInput}
            type="file"
            accept="image/*"
            hidden
            data-photo="cover"
            onChange={(event) => void readPhoto("cover", event, COVER_SIZE)}
          />
        </fieldset>
      </div>

      <div className={`${dialog.actions} ${styles.editActions}`}>
        <button type="submit" className="pill" aria-disabled={busy !== null || undefined}>
          Save
        </button>
        <Dialog.Close className="pill alt">Cancel</Dialog.Close>
      </div>
    </form>
  );
}
