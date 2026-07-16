// PageStub is the placeholder body the not-yet-implemented pages render. A parallel
// stage replaces each page's contents with the real screen; until then this keeps
// the app building and gives the operator a titled, themed shell rather than a bare
// "TODO" string.
export default function PageStub({ title, description }) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-100">{title}</h1>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-6 card flex items-center justify-center p-12 text-sm text-faint">
        TODO — this screen is not yet implemented.
      </div>
    </div>
  )
}
