const { html, css } = Utils;
const { Button, showNotification } = Components.UI;
const { updateEntry, createEntry, deleteEntry } = Netlify;
const { readForm } = EntryFormIO;

const DeleteButton = (type, data) =>
  Button({
    label: "Delete",
    style: ({ id }) => css`
      #${id} {
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
            showNotification(`Error deleting this entry: ${err}`)
          );
      }
    },
  });

const SubmitButton = (type, data, isEdit) =>
  Button({
    label: isEdit ? "Edit entry" : "Add entry",
    style: ({ id }) => css`
      #${id} {
        ${buttonStyle("#0E9CE0")}
        margin-right: 5px;
      }
    `,
    onClick: () =>
      (isEdit
        ? updateEntry(type, data.dbRef, readForm(data, type))
        : createEntry(type, readForm(data, type))
      )
        .map(() => location.reload())
        .mapErr((err) =>
          showNotification(
            `Error ${isEdit ? "editing" : "adding"} this entry: ${err}`
          )
        ),
  });

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
