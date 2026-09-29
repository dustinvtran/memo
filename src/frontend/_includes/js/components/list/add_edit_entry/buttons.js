const { css } = Utils;
const { Button, showNotification } = Components.UI;
const { updateEntry, createEntry, deleteEntry } = Netlify;
const { readForm, clearedFields } = EntryFormIO;
const { errorMessage } = Http;

const DeleteButton = (type, data) =>
  Button({
    label: "Delete",
    className: "td-delete-entry-button",
    style: () => css`
      .td-delete-entry-button {
        ${buttonStyle("#e0480e")}
        margin-left: 5px;
      }
    `,
    onClick: () => {
      if (
        confirm(`Are you sure you want to delete this entry from your list?`)
      ) {
        deleteEntry(type, data.dbRef)
          .map(() => location.reload())
          .mapErr((err) =>
            showNotification(
              `Error deleting this entry: ${errorMessage(err)}`
            )
          );
      }
    },
  });

const SubmitButton = (type, data, isEdit) =>
  Button({
    label: isEdit ? "Edit entry" : "Add entry",
    className: "td-submit-entry-button",
    style: () => css`
      .td-submit-entry-button {
        ${buttonStyle("#0E9CE0")}
        margin-right: 5px;
      }
    `,
    onClick: () => {
      const cleared = clearedFields(data, type);
      if (cleared.length > 0) {
        showNotification(clearedMessage(cleared));
        return;
      }
      (isEdit
        ? updateEntry(type, data.dbRef, readForm(data, type))
        : createEntry(type, readForm(data, type))
      )
        .map(() => location.reload())
        .mapErr((err) =>
          showNotification(
            `Error ${isEdit ? "editing" : "adding"} this entry: ${errorMessage(err)}`
          )
        );
    },
  });

/**
 * Why nothing was saved, naming each emptied field and what the database has
 * in it. An empty field used to be stored as a `null` that hid the work's
 * value; now it is refused, out loud, rather than turned into something the
 * person did not type. #478.
 */
const clearedMessage = (cleared) =>
  `Nothing was saved: ${cleared
    .map(({ label, theirs }) => `${label} is empty (database value: ${theirs})`)
    .join("; ")}. Type the database value back in to use it, or type what it should be.`;

Components.List.SubmitButton = SubmitButton;
Components.List.DeleteButton = DeleteButton;

///////////////////////////////////////////////////////////////////////////////

const buttonStyle = (color) => `
  margin: auto;
  cursor: pointer;
  padding: 10px 30px;
  background: ${color};
  border-radius: 7px;
  color: white;
  border: 0;
  font-weight: bold;
  font-size: 17px;
  margin-bottom: 10px;
  display: inline-block;
`;
