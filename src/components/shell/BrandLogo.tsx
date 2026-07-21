/** Brand mark extracted from the v1 App.tsx header (visuals unchanged). */
export function BrandLogo() {
  return (
    <div
      className="flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg"
      style={{
        background: "linear-gradient(150deg, #4f46e5, #7c3aed)",
        boxShadow: "0 6px 16px -6px rgba(79,70,229,.7)",
      }}
      aria-hidden="true"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
        <path d="M21 6c-1.6-.4-3.2 0-4.5 1C15 5.3 12.6 4.5 10 5 6 5.7 3 9 3 13c0 3 1.8 5.3 4 6l-1 3 3-1.2c.7.1 1.4.2 2 .2 4.4 0 8-3.1 8-7 0-1 0-1.9-.4-2.7L21 9V6ZM9 12a1.2 1.2 0 1 1 0-2.4A1.2 1.2 0 0 1 9 12Z" />
      </svg>
    </div>
  );
}
